import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, checkPlacement, colorFor, homeSquares, minersLeft, randomSetup, resolveCombat, rowOf, sealedFlag, shuttleBlocked, simulate, type Color, type Round } from '../src/game.ts';
import { ARMY, PIECES, PIECE_BY_RANK, type Rank } from '../src/pieces.ts';
import { commitment } from '../src/crypto.ts';

const noop = () => {};
const canon = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/** Fills the home rows with a full army, honouring the requested squares first. */
function layout(color: Color, fixed: Record<number, Rank>): Record<number, Rank> {
  const placement: Record<number, Rank> = { ...fixed };
  const left = [...ARMY];
  for (const rank of Object.values(fixed)) left.splice(left.indexOf(rank), 1);
  for (const square of homeSquares(color)) if (!(square in placement)) placement[square] = left.shift()!;
  return placement;
}

/** Exchanges snapshots until both peers agree; auto-responses (defend/stuck) happen inside receive. */
async function sync(a: Game, b: Game) {
  for (let i = 0; i < 8; i++) {
    await b.receive(a.snapshot().rounds);
    await a.receive(b.snapshot().rounds);
    if (canon(a.snapshot()) === canon(b.snapshot())) return;
  }
  throw new Error('Peers did not converge');
}

async function table(red: Record<number, Rank>, blue: Record<number, Rank>) {
  const host = new Game('room', null, noop, 'host'), guest = new Game('room', null, noop, 'guest');
  await host.commitSetup(layout('red', red));
  await guest.commitSetup(layout('blue', blue));
  await sync(host, guest);
  assert.equal(host.view().phase, 'play');
  return { host, guest };
}

test('an army has 40 pieces in the classic distribution', () => {
  assert.equal(ARMY.length, 40);
  assert.equal(PIECES.reduce((n, p) => n + p.count, 0), 40);
  assert.deepEqual(PIECES.map(p => [p.rank, p.count]), [['10', 1], ['9', 1], ['8', 2], ['7', 3], ['6', 4], ['5', 4], ['4', 4], ['3', 5], ['2', 8], ['S', 1], ['B', 6], ['F', 1]]);
});

test('random setups are complete, legal, and keep the flag on the back row', () => {
  for (const color of ['red', 'blue'] as const) {
    for (let i = 0; i < 25; i++) {
      const placement = randomSetup(color);
      checkPlacement(color, placement);
      const flag = Number(Object.keys(placement).find(sq => placement[Number(sq)] === 'F'));
      assert.equal(rowOf(flag), color === 'red' ? 9 : 0);
    }
  }
  assert.throws(() => checkPlacement('red', layout('blue', {})), GameError);
});

test('combat follows the rank table with the three special cases', () => {
  assert.equal(resolveCombat('S', '10'), 'attacker');
  assert.equal(resolveCombat('10', 'S'), 'attacker');
  assert.equal(resolveCombat('3', 'B'), 'attacker');
  assert.equal(resolveCombat('10', 'B'), 'defender');
  assert.equal(resolveCombat('4', '4'), 'both');
  assert.equal(resolveCombat('2', 'F'), 'flag');
  assert.equal(resolveCombat('7', '8'), 'defender');
  assert.equal(resolveCombat('9', '8'), 'attacker');
  assert.equal(resolveCombat('S', '2'), 'defender');
});

test('colours alternate by round and red moves first', async () => {
  assert.equal(colorFor('host', 0), 'red'); assert.equal(colorFor('guest', 0), 'blue');
  assert.equal(colorFor('host', 1), 'blue'); assert.equal(colorFor('guest', 1), 'red');
  const { host, guest } = await table({ 60: '6' }, { 30: '6' });
  assert.equal(host.view().myTurn, true);
  assert.equal(guest.view().myTurn, false);
  assert.throws(() => guest.move(30, 40), GameError);
});

test('movement: one square orthogonally, lakes blocked, bombs and flags fixed, scouts run and reveal', async () => {
  const { host, guest } = await table({ 60: '6', 62: '5', 69: 'B', 79: 'F', 65: '2' }, { 30: '6' });
  assert.deepEqual(host.legalTargets(60).sort(), [50]);
  assert.deepEqual(host.legalTargets(62), []);            // 52 is a lake, neighbours are friends
  assert.deepEqual(host.legalTargets(69), []);            // bomb
  assert.deepEqual(host.legalTargets(79), []);            // flag
  assert.deepEqual(host.legalTargets(65).sort((a, b) => a - b), [35, 45, 55]); // scout runs north and may strike the blue piece at 35
  assert.throws(() => host.move(60, 61), GameError);      // own piece
  assert.throws(() => host.move(60, 41), GameError);      // not a straight line
  host.move(65, 45);
  await sync(host, guest);
  const seen = guest.view().board[45]!;
  assert.equal(seen.owner, 'red'); assert.equal(seen.rank, '2'); assert.equal(seen.revealed, true);
  assert.equal(guest.view().board[60]!.rank, null);      // unmoved and unrevealed
});

test('a scout runs any distance over empty squares but never through pieces or lakes', async () => {
  // Official rule: the Scout moves any number of open squares in a straight line, like a rook,
  // cannot jump over pieces or lakes, and may attack at the end of its run.
  const { host, guest } = await table({ 60: '2', 64: '2', 61: '5' }, { 30: '6', 34: '6' });
  assert.deepEqual(host.legalTargets(60).sort((a, b) => a - b), [30, 40, 50]);        // A-file: two empty squares, then the blue piece on A7 to strike
  assert.deepEqual(host.legalTargets(62), []);                                        // C4 faces the lake on C5; its neighbours are its own
  host.move(61, 51); await sync(host, guest); guest.move(34, 44); await sync(host, guest);   // red lieutenant B4→B5, blue E7→E6
  host.move(51, 41); await sync(host, guest); guest.move(44, 45); await sync(host, guest);   // B5→B6, blue E6→F6
  host.move(41, 40); await sync(host, guest); guest.move(45, 44); await sync(host, guest);   // B6→A6, blue back to E6
  assert.deepEqual(host.legalTargets(60).sort((a, b) => a - b), [50, 61]);           // own lieutenant on A6 stops the run at A5; B4 is empty sideways
  assert.throws(() => host.move(60, 30), GameError);                                  // no jumping over it to strike A7
  assert.deepEqual(host.legalTargets(64).sort((a, b) => a - b), [44, 54]);           // E4: E5 empty, then the blue piece on E6
  host.move(64, 44);                                                                  // run two squares and strike in the same turn
  await sync(host, guest);
  assert.equal(guest.view().lastCombat?.attacker.rank, '2');
  assert.equal(guest.view().lastCombat?.result, 'defender');
});

test('the two-square rule forbids a fourth consecutive shuttle', async () => {
  const { host, guest } = await table({ 60: '6' }, { 30: '6' });
  host.move(60, 50); await sync(host, guest); guest.move(30, 40); await sync(host, guest);
  host.move(50, 60); await sync(host, guest); guest.move(40, 30); await sync(host, guest);
  host.move(60, 50); await sync(host, guest); guest.move(30, 40); await sync(host, guest);
  assert.deepEqual(host.legalTargets(50).sort((a, b) => a - b), [40, 51]); // attack or sidestep, but no retreat to 60
  assert.throws(() => host.move(50, 60), GameError);
  host.move(61, 51); await sync(host, guest);
  assert.deepEqual(guest.legalTargets(40).sort((a, b) => a - b), [41, 50]); // blue is also on its third shuttle
  assert.ok(shuttleBlocked([{ id: 'x', a: 1, b: 2 }, { id: 'x', a: 2, b: 1 }, { id: 'x', a: 1, b: 2 }], 'x', 2, 1));
  assert.ok(!shuttleBlocked([{ id: 'x', a: 1, b: 2 }, { id: 'y', a: 2, b: 1 }, { id: 'x', a: 1, b: 2 }], 'x', 2, 1));
});

test('an attack reveals both pieces, the defender answers automatically, and both peers agree', async () => {
  const { host, guest } = await table({ 60: '10' }, { 30: '2' });
  host.move(60, 50); await sync(host, guest);
  assert.equal(guest.view().board[50]!.rank, null);
  guest.move(30, 50);                                      // scout strikes the unknown piece
  assert.ok(guest.view().pending);
  await sync(host, guest);
  for (const game of [host, guest]) {
    const v = game.view();
    assert.equal(v.pending, null);
    assert.equal(v.lastCombat?.result, 'defender');
    assert.deepEqual(v.captured, { red: [], blue: ['2'] });
    assert.equal(v.board[50]!.rank, '10');
    assert.equal(v.board[50]!.revealed, true);
    assert.equal(v.board[30], null);
    assert.equal(v.turn, 'red');
  }
});

test('capturing the flag ends the round and the loser can request a rematch with swapped colours', async () => {
  const { host, guest } = await table({ 60: '5' }, { 30: 'F', 31: 'B' });
  host.move(60, 50); await sync(host, guest); guest.move(34, 44); await sync(host, guest);
  host.move(50, 40); await sync(host, guest); guest.move(44, 34); await sync(host, guest);
  host.move(40, 30); await sync(host, guest);
  assert.equal(host.view().outcome, 'win'); assert.equal(guest.view().outcome, 'loss'); assert.equal(guest.view().reason, 'flag');
  assert.deepEqual(host.view().captured.blue, ['F']);
  assert.throws(() => guest.move(34, 44), GameError);
  guest.playAgain(); await sync(host, guest);
  assert.equal(host.view().theirAgain, true); assert.equal(host.view().round, 1);
  host.playAgain(); await sync(host, guest);
  assert.equal(host.view().round, 2); assert.equal(host.view().phase, 'setup');
  assert.equal(host.color, 'blue'); assert.equal(guest.color, 'red');
});

test('a player with no movable pieces reveals the army and loses', async () => {
  // Bombs on every blue front square that does not face a lake box the whole blue army in.
  const { host, guest } = await table({ 60: '6' }, { 30: 'B', 31: 'B', 34: 'B', 35: 'B', 38: 'B', 39: 'B' });
  assert.equal(guest.respond(), false);                    // red has not moved yet, so blue is not on turn
  host.move(60, 50); await sync(host, guest);              // blue's client detects the stalemate and proves it
  for (const game of [host, guest]) {
    assert.equal(game.view().winner, 'red'); assert.equal(game.view().reason, 'stuck');
  }
  assert.equal(host.view().outcome, 'win');
  const revealed = host.view().board.filter(p => p?.owner === 'blue');
  assert.equal(revealed.length, 40);
  assert.ok(revealed.every(p => p!.rank && p!.revealed));
  assert.equal(revealed.filter(p => p!.rank === 'B').length, 6);
});

test('a tampered reveal is rejected and freezes the game', async () => {
  const { host, guest } = await table({ 60: '10', 61: '6' }, { 30: '2' });
  host.move(60, 50); await sync(host, guest); guest.move(30, 40); await sync(host, guest);
  host.move(61, 51); await sync(host, guest);
  guest.move(40, 50);                                      // the scout attacks the marshal
  const forged = JSON.parse(JSON.stringify(guest.snapshot().rounds)) as Round[];
  const event = forged[0]!.log.at(-1)!;
  assert.equal(event.type, 'move');
  (event as { reveal: { rank: Rank } }).reveal.rank = '10';   // claims the scout is a marshal
  await assert.rejects(() => host.receive(forged), GameError);
  assert.match(host.error, /commitment/);
  assert.throws(() => host.move(51, 41), GameError);      // the frozen game refuses further play
});

test('a peer cannot act on the other player’s behalf or rewrite history', async () => {
  const { host, guest } = await table({ 60: '10' }, { 30: '2' });
  const forged = JSON.parse(JSON.stringify(host.snapshot().rounds)) as Round[];
  forged[0]!.log.push({ type: 'move', by: 'blue', from: 30, to: 40 });
  await assert.rejects(() => guest.receive(forged), /on your behalf/);
  const fresh = new Game('room', guest.saved(), noop, 'guest');
  const rewritten = JSON.parse(JSON.stringify(fresh.snapshot().rounds)) as Round[];
  rewritten[0]!.setups.red![0]!.square = 61 === rewritten[0]!.setups.red![0]!.square ? 62 : 61;
  await assert.rejects(() => fresh.receive(rewritten), /changed after it was placed|home rows/);
});

test('commitments bind a piece id to its rank and salt', async () => {
  const a = await commitment('7', '10', 'a'.repeat(32)), b = await commitment('7', '9', 'a'.repeat(32));
  assert.notEqual(a, b); assert.equal(a.length, 64);
});

test('a phone that slept through an attack rejoins from its saved seat and catches up', async () => {
  const { host, guest } = await table({ 60: '10', 61: '6' }, { 30: '2', 31: '4' });
  host.move(60, 50); await sync(host, guest); guest.move(30, 40); await sync(host, guest);
  host.move(61, 51); await sync(host, guest);
  const asleep = JSON.parse(JSON.stringify(host.saved()));                            // the host's phone goes to sleep here
  guest.move(40, 50);                                                                 // the blue scout strikes the marshal; no defender answers
  assert.ok(guest.view().pending);
  const phone = new Game('room', asleep, noop, 'host');                              // the phone reopens the room link with its saved seat
  assert.equal(phone.view().moveCount, 3);
  await phone.receive(guest.snapshot().rounds);                                       // the connected peer's snapshot arrives on reconnect
  await sync(phone, guest);                                                           // the phone defended automatically and both agree
  for (const g of [phone, guest]) {
    assert.equal(g.view().pending, null);
    assert.deepEqual(g.view().captured, { red: [], blue: ['2'] });
    assert.equal(g.view().board[50]!.rank, '10');
    assert.equal(g.view().turn, 'red');
  }
  phone.move(50, 40); await sync(phone, guest);                                       // and it keeps playing with its own army
  assert.equal(guest.view().board[40]!.rank, '10');
});

test('saved state restores the same view, and resignation ends the round', async () => {
  const { host, guest } = await table({ 60: '10' }, { 30: '2' });
  host.move(60, 50); await sync(host, guest);
  const restored = new Game('room', JSON.parse(JSON.stringify(host.saved())), noop, 'host');
  assert.deepEqual(restored.view(), host.view());
  guest.resign(); await sync(host, guest);
  assert.equal(host.view().outcome, 'win'); assert.equal(host.view().reason, 'resigned'); assert.equal(guest.view().outcome, 'loss');
  assert.equal(PIECE_BY_RANK['3'].name, 'Miner');
});

/** Both flags in a corner sealed by two bombs; five Miners per side face each other on the open files. */
const sealedRed: Record<number, Rank> = { 90: 'F', 80: 'B', 91: 'B', 60: '3', 61: '3', 65: '3', 68: '3', 69: '3' };
const sealedBlue: Record<number, Rank> = { 0: 'F', 1: 'B', 10: 'B', 30: '3', 31: '3', 35: '3', 38: '3', 39: '3' };
/** The first legal move of the side to play. */
const anyMove = (game: Game): [number, number] => { for (let sq = 0; sq < 100; sq++) { const t = game.legalTargets(sq); if (t.length) return [sq, t[0]!]; } throw new Error('no move'); };
/** On each open file a Miner marches out and trades with its opposite number; the side to move leads each trade. */
async function tradeMiners(host: Game, guest: Game) {
  for (const [i, col] of [0, 1, 5, 8, 9].entries()) {
    const [lead, follow, leadHome, followHome] = i % 2 === 0 ? [host, guest, 60, 30] : [guest, host, 30, 60];
    const step = (from: number, home: number) => (home === 60 ? from - 10 : from + 10);
    lead.move(leadHome + col, step(leadHome + col, leadHome)); await sync(host, guest);
    follow.move(followHome + col, step(followHome + col, followHome)); await sync(host, guest);
    lead.move(step(leadHome + col, leadHome), step(followHome + col, followHome)); await sync(host, guest);   // Miner vs Miner: both removed
  }
}

test('when both flags are sealed behind bombs and no Miner is left, the round is a draw', async () => {
  const { host, guest } = await table(sealedRed, sealedBlue);
  assert.equal(sealedFlag(host.sim().board, 'red'), 90);
  assert.equal(sealedFlag(host.sim().board, 'blue'), null);          // blue's flag is unknown to red until revealed
  await tradeMiners(host, guest);
  assert.equal(host.view().lastCombat?.result, 'both');
  assert.equal(minersLeft(host.sim(), 'red'), 0); assert.equal(minersLeft(host.sim(), 'blue'), 0);
  // Blue's turn: its client proved its sealed flag (no turn spent) and still has to move; red then proves its own.
  assert.equal(guest.view().turn, 'blue'); assert.equal(guest.view().phase, 'play');
  assert.ok(guest.round.log.at(-1)?.type === 'dead');
  const [from, to] = anyMove(guest);                                   // any ordinary move; red's client then claims and the draw is sealed
  guest.move(from, to); await sync(host, guest);
  for (const g of [host, guest]) {
    assert.equal(g.view().phase, 'over'); assert.equal(g.view().outcome, 'draw'); assert.equal(g.view().reason, 'dead'); assert.equal(g.view().winner, null);
    assert.equal(g.view().board[0]!.rank, 'F'); assert.equal(g.view().board[90]!.rank, 'F');   // both flags now revealed
  }
  assert.throws(() => guest.move(to, from), GameError);
  guest.playAgain(); host.playAgain(); await sync(host, guest);
  assert.equal(host.view().round, 2);
});

test('a dead-position claim is refused while an enemy Miner survives or the flag has an open side', async () => {
  const { host, guest } = await table(sealedRed, { ...sealedBlue, 10: '6' });   // blue's flag has a Captain beside it, not a bomb
  const forge = (game: Game, ids: string[]) => {
    const round: Round = JSON.parse(JSON.stringify(game.round));
    const priv = game.private[0]!;
    round.log.push({ type: 'dead', by: game.color, reveals: Object.fromEntries(ids.map(id => [id, { rank: priv.ranks[id]!, salt: priv.salts[id]! }])) });
    return round;
  };
  const redIds = (squares: number[]) => host.round.setups.red!.filter(e => squares.includes(e.square)).map(e => e.id);
  assert.throws(() => simulate(forge(host, redIds([90, 80, 91])), { red: host.private[0]!.ranks }), /every enemy Miner captured/);
  await tradeMiners(host, guest);
  const blueIds = (squares: number[]) => guest.round.setups.blue!.filter(e => squares.includes(e.square)).map(e => e.id);
  assert.throws(() => simulate(forge(guest, blueIds([0, 1, 10])), { blue: guest.private[0]!.ranks }), /not sealed/);
  assert.ok(!guest.round.log.some(e => e.type === 'dead'));           // no automatic claim for blue: its flag is not sealed
  assert.equal(guest.view().phase, 'play');
  const [from, to] = anyMove(guest); guest.move(from, to); await sync(host, guest);
  assert.equal(host.round.log.at(-1)?.type, 'dead');                  // red's flag is sealed, so red claims on its turn…
  assert.equal(host.view().phase, 'play');                            // …but one claim alone does not end the game
});
