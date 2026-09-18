// Headless self-play for tuning the computer opponent.
//
//   node scripts/arena.ts [games] [red] [blue]
//
// Each side is `random` (a legal move at random, captures preferred), `weak`
// (the bot with a shallow, quick search) or `bot` (the bot as shipped).
// Prints the result of every game, the totals, and the time spent per move.
import { Game, type Color } from '../src/game.ts';
import { beliefs, chooseMove, chooseSetup, stats, type BotOptions } from '../src/bot.ts';

type Player = 'random' | 'weak' | 'bot' | 'red-opts' | 'blue-opts' | 'base';
/** BASE_BOT: path to an older copy of bot.ts; the `base` player uses its chooseMove with the shipped settings. */
const baseBot: { chooseMove: typeof chooseMove } | null = process.env.BASE_BOT ? await import(process.env.BASE_BOT) : null;
/** RED_OPTS / BLUE_OPTS: JSON BotOptions for the `red-opts` / `blue-opts` players, e.g. RED_OPTS='{"maxDepth":2}'. */
const OPTIONS: Record<Exclude<Player, 'random'>, BotOptions> = { weak: { timeMs: 20, samples: 2, maxDepth: 2 }, bot: { timeMs: 500, samples: 16, maxDepth: 3 }, base: { timeMs: 500, samples: 16, maxDepth: 3 }, 'red-opts': JSON.parse(process.env.RED_OPTS ?? '{}'), 'blue-opts': JSON.parse(process.env.BLUE_OPTS ?? '{}') };
const games = Number(process.argv[2] ?? 4);
const players: Record<Color, Player> = { red: (process.argv[3] as Player) ?? 'bot', blue: (process.argv[4] as Player) ?? 'random' };
const MAX_MOVES = 1500;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const canon = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
async function converge(a: Game, b: Game) {
  for (let i = 0; i < 8; i++) {
    await b.receive(clone(a.snapshot().rounds));
    await a.receive(clone(b.snapshot().rounds));
    if (canon(a.snapshot()) === canon(b.snapshot())) return;
  }
  throw new Error('Peers did not converge');
}
function randomMove(game: Game) {
  const sim = game.sim();
  const moves: { from: number; to: number; capture: boolean }[] = [];
  for (let sq = 0; sq < 100; sq++) if (sim.board[sq]?.owner === game.color) for (const to of game.legalTargets(sq)) moves.push({ from: sq, to, capture: !!sim.board[to] });
  const captures = moves.filter(m => m.capture && sim.board[m.to]!.rank !== 'B');
  const pool = captures.length && Math.random() < 0.5 ? captures : moves;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

const totals: Record<Color | 'draw', number> = { red: 0, blue: 0, draw: 0 };
const depths: Record<Color, Record<number, number>> = { red: {}, blue: {} }; let nodesTotal = 0;
const timing: Record<Color, { ms: number; moves: number }> = { red: { ms: 0, moves: 0 }, blue: { ms: 0, moves: 0 } };
for (let g = 0; g < games; g++) {
  const host = new Game('arena', null, () => {}, 'host'), guest = new Game('arena', null, () => {}, 'guest');
  await host.commitSetup(chooseSetup(host.color));
  await guest.commitSetup(chooseSetup(guest.color));
  await converge(host, guest);
  let moves = 0;
  const lastMove: Record<Color, { from: number; to: number } | null> = { red: null, blue: null }, reversals: Record<Color, number> = { red: 0, blue: 0 };
  const used: Record<Color, Set<string>> = { red: new Set(), blue: new Set() };
  while (host.view().phase === 'play' && moves < MAX_MOVES) {
    const mover = host.view().myTurn ? host : guest;
    const kind = players[mover.color];
    const t0 = performance.now();
    const input = { round: mover.round, sim: mover.sim(), me: mover.color, options: OPTIONS[kind as Exclude<Player, 'random'>] };
    const move = kind === 'random' ? randomMove(mover) : kind === 'base' ? baseBot!.chooseMove(input) : chooseMove(input);
    timing[mover.color].ms += performance.now() - t0; timing[mover.color].moves++;
    if (kind !== 'random' && process.env.BOT_DEBUG) { const d = depths[mover.color]; d[stats.depth] = (d[stats.depth] ?? 0) + 1; nodesTotal += stats.nodes; }
    if (!move) throw new Error(`${mover.color} found no move but the engine did not declare it stuck`);
    if (process.env.BOT_DEBUG && kind !== 'random') {
      const sim = mover.sim(), attacker = sim.board[move.from]!, target = sim.board[move.to];
      if (target && !target.rank && !target.moved && (attacker.rank === '10' || attacker.rank === '9' || attacker.rank === '8')) {
        const d = beliefs(mover.round, sim, mover.color).get(move.to)!;
        console.log(`  move ${moves + 1}: ${mover.color} ${attacker.rank} strikes unmoved ${move.to} · belief ${Object.entries(d).filter(([, v]) => v > 0.02).map(([r, v]) => `${r}:${v.toFixed(2)}`).join(' ')}`);
        if (d.B > 0.25 && process.env.BOT_DUMP) { const fs = await import('node:fs'); fs.writeFileSync(`${process.env.BOT_DUMP}/strike-${g + 1}-${moves + 1}.json`, JSON.stringify({ saved: mover.saved(), role: mover.role, move })); }
      }
    }
    used[mover.color].add(mover.sim().board[move.from]!.id);
    const last = lastMove[mover.color];
    if (last && last.from === move.to && last.to === move.from) reversals[mover.color]++;
    lastMove[mover.color] = move;
    mover.move(move.from, move.to);
    await converge(host, guest);
    moves++;
  }
  const v = host.view();
  if (process.env.BOT_DEBUG) for (const c of v.combats) {
    const loser = c.result === 'attacker' || c.result === 'flag' ? c.defender : c.result === 'defender' ? c.attacker : null;
    if (process.env.BOT_DEBUG === 'all' || (loser && (loser.rank === '10' || loser.rank === '9' || loser.rank === 'S'))) console.log(`  turn ${c.turn}: ${c.attacker.owner} ${c.attacker.rank} attacked ${c.defender.owner} ${c.defender.rank} on ${c.square} → ${c.result}`);
  }
  const result = v.phase !== 'play' ? (v.winner ?? 'draw') : 'draw';
  totals[result]++;
  const alive = v.alive, cap = v.captured;
  console.log(`game ${g + 1}: ${result === 'draw' ? (v.phase === 'play' ? `unfinished after ${moves} moves` : 'draw') : `${result} wins by ${v.reason}`} in ${moves} moves · reversals red ${reversals.red} blue ${reversals.blue} · pieces used red ${used.red.size} blue ${used.blue.size} · alive red ${alive.red} blue ${alive.blue} · captured from red ${cap.red.join(' ')} · from blue ${cap.blue.join(' ')}`);
}
console.log(`\nred (${players.red}) ${totals.red} · blue (${players.blue}) ${totals.blue} · draws/unfinished ${totals.draw}`);
for (const color of ['red', 'blue'] as const) console.log(`${color}: ${(timing[color].ms / Math.max(1, timing[color].moves)).toFixed(1)} ms per move over ${timing[color].moves} moves`);
if (process.env.BOT_DEBUG) console.log(`search depth reached: ${JSON.stringify(depths)} · ${Math.round(nodesTotal / 1000 / (Object.values(timing).reduce((s, t) => s + t.ms, 0) / 1000))}k nodes/s`);
