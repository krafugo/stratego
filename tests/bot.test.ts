import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, checkPlacement, homeSquares, neighbours, rowOf, type Color } from '../src/game.ts';
import { ARMY, RANKS, type Rank } from '../src/pieces.ts';
import { beliefs, chooseMove, chooseSetup, hiddenCounts, stats } from '../src/bot.ts';

const noop = () => {};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const canon = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/** Quick settings for tests: a shallow search over a couple of sampled armies. */
const QUICK = { timeMs: 200, samples: 8, maxDepth: 2 };

/** Fills the home rows with a full army, honouring the requested squares first. */
function layout(color: Color, fixed: Record<number, Rank>): Record<number, Rank> {
  const placement: Record<number, Rank> = { ...fixed };
  const left = [...ARMY];
  for (const rank of Object.values(fixed)) left.splice(left.indexOf(rank), 1);
  for (const square of homeSquares(color)) if (!(square in placement)) placement[square] = left.shift()!;
  return placement;
}
/** Exchanges transcripts until both engines agree, exactly as the page does for the computer's seat. */
async function converge(a: Game, b: Game) {
  for (let i = 0; i < 8; i++) {
    await b.receive(clone(a.snapshot().rounds));
    await a.receive(clone(b.snapshot().rounds));
    if (canon(a.snapshot()) === canon(b.snapshot())) return;
  }
  throw new Error('Engines did not converge');
}
async function table(red: Record<number, Rank>, blue: Record<number, Rank>) {
  const host = new Game('bot', null, noop, 'host'), guest = new Game('bot', null, noop, 'guest');
  await host.commitSetup(red);
  await guest.commitSetup(blue);
  await converge(host, guest);
  assert.equal(host.view().phase, 'play');
  return { host, guest };
}
const think = (game: Game, options = QUICK) => chooseMove({ round: game.round, sim: game.sim(), me: game.color, options });
const flagOf = (placement: Record<number, Rank>) => Number(Object.keys(placement).find(sq => placement[Number(sq)] === 'F'));

test('the computer arranges a complete, legal army built on sound principles', () => {
  for (const color of ['red', 'blue'] as const) {
    for (let i = 0; i < 40; i++) {
      const placement = chooseSetup(color);
      checkPlacement(color, placement);
      const flag = flagOf(placement);
      assert.equal(rowOf(flag), color === 'red' ? 9 : 0, 'flag on the back row');
      for (const n of neighbours(flag)) assert.equal(placement[n], 'B', 'every open side of the flag is a bomb');
      const general = Number(Object.keys(placement).find(sq => placement[Number(sq)] === '9'));
      assert.ok(neighbours(general).some(n => placement[n] === 'S'), 'the Spy stands next to the General');
      const front = color === 'red' ? 6 : 3;
      assert.ok(Object.entries(placement).filter(([sq, rank]) => rank === '2' && rowOf(Number(sq)) === front).length >= 3, 'Scouts lead from the front row');
      assert.ok(Object.entries(placement).every(([sq, rank]) => rank !== '3' || Math.abs(rowOf(Number(sq)) - rowOf(flag)) <= 1), 'Miners stay in the two back rows');
    }
  }
  const a = JSON.stringify(chooseSetup('red')), b = JSON.stringify(chooseSetup('red'));
  assert.notEqual(a, b, 'no two layouts are alike');
});

test('beliefs honour the piece counts and everything the board reveals', async () => {
  const { host, guest } = await table(layout('red', { 60: '2', 65: '5' }), layout('blue', { 30: '2', 0: 'F', 1: 'B', 10: 'B' }));
  let b = beliefs(host.round, host.sim(), 'red');
  assert.equal(b.size, 40);
  for (const dist of b.values()) assert.ok(Math.abs(RANKS.reduce((s, r) => s + dist[r], 0) - 1) < 1e-6, 'each piece has exactly one rank');
  for (const rank of RANKS) {
    const expected = [...b.values()].reduce((s, d) => s + d[rank], 0);
    assert.ok(Math.abs(expected - hiddenCounts(host.sim(), 'blue')[rank]) < 1e-3, `the expected number of ${rank}s matches the hidden count`);
  }
  assert.ok(b.get(0)!.F > b.get(30)!.F * 5, 'the flag is far likelier on the back row than on the front');
  assert.ok(b.get(1)!.B > b.get(30)!.B, 'bombs are likelier behind than in front');
  // Pieces that step forward can no longer be bombs or the flag; a Scout that runs is revealed outright and drops out of the beliefs.
  host.move(60, 50); await converge(host, guest); guest.move(30, 40); await converge(host, guest);
  host.move(65, 55); await converge(host, guest); guest.move(31, 41); await converge(host, guest);
  b = beliefs(host.round, host.sim(), 'red');
  assert.equal(b.get(40)!.B, 0); assert.equal(b.get(40)!.F, 0);
  assert.equal(b.get(41)!.B, 0); assert.equal(b.get(41)!.F, 0);
});

test('the computer only ever plays legal moves and answers attacks automatically', async () => {
  const { host, guest } = await table(chooseSetup('red'), chooseSetup('blue'));
  for (let i = 0; i < 30 && host.view().phase === 'play'; i++) {
    const mover = host.view().myTurn ? host : guest;
    const move = think(mover);
    assert.ok(move, 'a move is found while the engine says there are moves');
    assert.ok(mover.legalTargets(move.from).includes(move.to), `${move.from}→${move.to} is legal`);
    mover.move(move.from, move.to);
    await converge(host, guest);
    assert.equal(host.view().pending, null, 'every attack was answered');
    assert.equal(host.error, ''); assert.equal(guest.error, '');
  }
  assert.ok(stats.depth >= 2, 'the quick search still looks a full exchange ahead');
});

test('the computer takes a free capture and never walks into a known bomb', async () => {
  // Red: Scouts at 60 and 65, a Captain at 61, the Marshal at 64. Blue: a bomb at 30, a Captain at 35, two fillers at 38 and 39.
  const { host, guest } = await table(layout('red', { 60: '2', 61: '6', 64: '10', 65: '2' }), layout('blue', { 30: 'B', 35: '6', 38: '3', 39: '3' }));
  const play = async (moves: [Game, number, number][]) => { for (const [g, from, to] of moves) { g.move(from, to); await converge(host, guest); } };
  await play([[host, 65, 55], [guest, 38, 48], [host, 55, 45], [guest, 39, 49], [host, 64, 54], [guest, 48, 38], [host, 54, 55], [guest, 35, 45]]);   // blue's Captain takes the Scout and stands revealed beside the Marshal
  assert.equal(host.view().board[45]!.rank, '6'); assert.equal(host.view().board[45]!.revealed, true);
  assert.deepEqual(think(host), { from: 55, to: 45 });
  await play([[host, 55, 45], [guest, 49, 39], [host, 60, 50], [guest, 38, 48], [host, 50, 40], [guest, 39, 49], [host, 40, 30]]);   // the Scout dies on the bomb, which is now known
  assert.equal(host.view().board[30]!.rank, 'B');
  await play([[guest, 48, 38], [host, 61, 51], [guest, 49, 39], [host, 51, 41], [guest, 38, 48], [host, 41, 40], [guest, 39, 49]]);  // the Captain now stands beside the known bomb
  assert.equal(host.view().board[40]!.rank, '6');
  for (let i = 0; i < 5; i++) assert.notDeepEqual(think(host), { from: 40, to: 30 });
});

test('the computer never attacks a revealed piece that beats the attacker', async () => {
  // Red's Captain at 61 walks up beside blue's Colonel, which reveals itself by taking a red Scout.
  const { host, guest } = await table(layout('red', { 60: '2', 61: '6', 64: '2' }), layout('blue', { 30: '8', 34: '3', 35: '3' }));
  const play = async (moves: [Game, number, number][]) => { for (const [g, from, to] of moves) { g.move(from, to); await converge(host, guest); } };
  await play([[host, 60, 50], [guest, 34, 44], [host, 50, 40], [guest, 30, 40], [host, 61, 51], [guest, 44, 34], [host, 51, 41]]);   // blue's Colonel took the Scout on 40; the Captain now stands beside it on 41
  assert.equal(host.view().board[40]!.rank, '8'); assert.equal(host.view().board[40]!.revealed, true);
  await play([[guest, 35, 45]]);
  for (let i = 0; i < 6; i++) assert.notDeepEqual(think(host), { from: 41, to: 40 });
});

test('the computer keeps most of its army still and lets few pieces do the work', async () => {
  const host = new Game('d', null, noop, 'host'), guest = new Game('d', null, noop, 'guest');
  await host.commitSetup(chooseSetup('red')); await guest.commitSetup(chooseSetup('blue'));
  await converge(host, guest);
  const used = new Set<string>();
  for (let i = 0; i < 40 && host.view().phase === 'play'; i++) {
    const mover = host.view().myTurn ? host : guest;
    const move = think(mover, { timeMs: 60, samples: 6, maxDepth: 2 })!;
    if (mover === host) used.add(host.sim().board[move.from]!.id);
    mover.move(move.from, move.to);
    await converge(host, guest);
  }
  assert.ok(used.size <= 10, `20 red moves were made by ${used.size} pieces`);
});

test('the Spy strikes a revealed Marshal when it can, and never steps up beside it', async () => {
  // Blue's Marshal reveals itself by capturing a red Scout on 50; red's Spy waits on 61.
  const { host, guest } = await table(layout('red', { 60: '2', 61: 'S', 64: '2' }), layout('blue', { 30: '10', 34: '3', 35: '3' }));
  const play = async (moves: [Game, number, number][]) => { for (const [g, from, to] of moves) { g.move(from, to); await converge(host, guest); } };
  await play([[host, 60, 50], [guest, 30, 40], [host, 64, 54], [guest, 40, 50]]);   // the Marshal takes the Scout on 50: revealed, two squares from the Spy on 61
  assert.equal(host.view().board[50]!.rank, '10'); assert.equal(host.view().board[50]!.revealed, true);
  for (let i = 0; i < 6; i++) { const m = think(host)!; assert.ok(!(m.from === 61 && m.to === 51) && !(m.from === 61 && m.to === 60), `the Spy does not walk into the Marshal's reach (${m.from}→${m.to})`); }
  await play([[host, 54, 44], [guest, 50, 51]]);   // the Marshal steps beside the Spy
  assert.deepEqual(think(host), { from: 61, to: 51 });
});

test('a Miner never gambles on a moved unknown piece', async () => {
  const { host, guest } = await table(layout('red', { 60: '3', 61: '2', 89: '10', 99: '9', 88: '8', 98: '8' }), layout('blue', { 30: '7', 34: '3', 35: '3' }));
  host.move(60, 50); await converge(host, guest); guest.move(30, 40); await converge(host, guest);   // an unknown blue piece that has moved stands beside the Miner
  assert.equal(host.view().board[40]!.moved, true); assert.equal(host.view().board[40]!.rank, null);
  assert.ok(host.legalTargets(50).includes(40));
  for (let i = 0; i < 6; i++) assert.notDeepEqual(think(host), { from: 50, to: 40 });
});

test('a Miner runs from a known officer instead of waiting to be taken', async () => {
  // Blue's Major reveals itself by taking a red Scout on 50, right in front of the unmoved Miner on 60, whose only way out is the square the Scout left.
  const { host, guest } = await table(layout('red', { 60: '3', 61: '2', 62: '4', 89: '10', 99: '9', 88: '8', 98: '8' }), layout('blue', { 30: '7', 34: '3', 35: '3' }));
  const play = async (moves: [Game, number, number][]) => { for (const [g, from, to] of moves) { g.move(from, to); await converge(host, guest); } };
  await play([[host, 61, 51], [guest, 30, 40], [host, 51, 50], [guest, 40, 50]]);
  assert.equal(host.view().board[50]!.rank, '7'); assert.equal(host.view().board[50]!.revealed, true);
  assert.deepEqual(host.legalTargets(60).sort(), [50, 61]);
  assert.deepEqual(think(host), { from: 60, to: 61 });
});

test('the computer beats a random mover and finishes the game', async () => {
  const host = new Game('arena', null, noop, 'host'), guest = new Game('arena', null, noop, 'guest');
  await host.commitSetup(chooseSetup('red')); await guest.commitSetup(chooseSetup('blue'));
  await converge(host, guest);
  const random = (game: Game) => {
    const sim = game.sim(), moves: { from: number; to: number }[] = [];
    for (let sq = 0; sq < 100; sq++) if (sim.board[sq]?.owner === game.color) for (const to of game.legalTargets(sq)) moves.push({ from: sq, to });
    return moves[Math.floor(Math.random() * moves.length)] ?? null;
  };
  let moves = 0;
  while (host.view().phase === 'play' && moves < 900) {
    const mover = host.view().myTurn ? host : guest;
    const move = mover === host ? think(host) : random(guest);
    assert.ok(move);
    mover.move(move.from, move.to);
    await converge(host, guest);
    moves++;
  }
  const v = host.view();
  assert.equal(v.phase, 'over', `the game ended (${moves} moves)`);
  assert.equal(v.outcome, 'win', `the computer won by ${v.reason}`);
});
