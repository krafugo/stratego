// The computer opponent.
//
// It plays from its own Game instance, so it sees exactly what a human in that
// seat would see: its own ranks, the enemy ranks revealed in combat, which
// enemy pieces have moved, and the move history. Nothing else.
//
// Three parts:
//  1. `chooseSetup` builds an army from well-known principles with enough
//     randomness that no two games look alike.
//  2. `beliefs` turns the evidence into a probability distribution over the
//     rank of every unknown enemy piece.
//  3. `chooseMove` samples complete enemy armies from those beliefs, searches
//     each sample a few plies deep with alpha-beta, and picks the move that
//     does best on average. Attacks on unknown pieces are averaged exactly
//     over every rank the target could be.
import { LAKES, colOf, homeSquares, neighbours, other, resolveCombat, rowOf, targets, type Color, type Round, type Sim } from './game.ts';
import { PIECE_BY_RANK, RANKS, type Rank } from './pieces.ts';

export interface Move { from: number; to: number }
export interface BotOptions { /** Search budget in milliseconds. */ timeMs?: number; /** Enemy armies sampled from the beliefs. */ samples?: number; maxDepth?: number }
export interface BotInput { round: Round; sim: Sim; me: Color; options?: BotOptions; /** Receives every root move with its final value, for tuning. */ trace?: (roots: { move: Move; value: number; score: number }[]) => void }
export type Distribution = Record<Rank, number>;
interface Recent { id: string; a: number; b: number }

const rnd = (n: number) => Math.floor(Math.random() * n);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}
function weighted<T>(items: readonly T[], weight: (item: T) => number): T | null {
  let total = 0;
  for (const item of items) total += weight(item);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const item of items) { r -= weight(item); if (r <= 0) return item; }
  return items[items.length - 1] ?? null;
}
const MOVABLE: readonly Rank[] = RANKS.filter(r => PIECE_BY_RANK[r].movable);
const NEIGHBOURS: readonly (readonly number[])[] = Array.from({ length: 100 }, (_, sq) => neighbours(sq).filter(n => !LAKES.has(n)));
const distance = (a: number, b: number) => Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
const steps = (from: number, to: number) => (rowOf(from) === rowOf(to) ? Math.abs(colOf(to) - colOf(from)) : Math.abs(rowOf(to) - rowOf(from)));
/** Rows advanced from the back row: 0 at home, 9 on the enemy's back row. */
const advance = (color: Color, sq: number) => (color === 'red' ? 9 - rowOf(sq) : rowOf(sq));
/** Depth of a home square: 0 on the back row, 3 on the front row. */
const depthOf = (color: Color, sq: number) => (color === 'blue' ? rowOf(sq) : 9 - rowOf(sq));
const zero = () => Object.fromEntries(RANKS.map(r => [r, 0])) as Record<Rank, number>;

// ---------- Setup ----------
const OPEN_FILES = new Set([0, 1, 4, 5, 8, 9]);
const LAKE_FILES = new Set([2, 3, 6, 7]);
const mirror = (sq: number) => 99 - sq;

/** An army layout built on well-known principles: flag walled in on the back row, decoy bombs, Spy beside the General, Scouts and officers up front, Miners safe behind. Built in red's frame and mirrored for blue. */
export function chooseSetup(color: Color): Record<number, Rank> {
  const placement: Record<number, Rank> = {};
  const free = new Set(homeSquares('red'));
  const put = (sq: number, rank: Rank) => { free.delete(sq); placement[sq] = rank; };
  /** A random free square matching the test, or any free square when none does. */
  const pick = (test: (sq: number) => boolean) => { const open = [...free].filter(test); const pool = open.length ? open : [...free]; return pool[rnd(pool.length)]!; };

  // The flag sits on the back row, a little more often in a corner, with a bomb on every open side.
  const flagCol = [0, 0, 9, 9, 1, 2, 3, 4, 5, 6, 7, 8][rnd(12)]!;
  const flag = 90 + flagCol;
  put(flag, 'F');
  let bombs = 6;
  for (const sq of neighbours(flag)) if (free.has(sq)) { put(sq, 'B'); bombs--; }
  // The other bombs are decoys: one or two in front of the lakes, where pieces rounding a lake run into them, the rest as a fake nest away from the flag.
  for (const sq of shuffled([62, 63, 66, 67]).slice(0, 1 + rnd(2))) if (bombs > 0) { put(sq, 'B'); bombs--; }
  while (bombs > 0) { put(pick(sq => rowOf(sq) >= 8 && Math.abs(colOf(sq) - flagCol) >= 3), 'B'); bombs--; }
  // The General keeps the Spy at its side; the Marshal takes the other wing.
  const left = rnd(2) === 0;
  const wing = (sq: number, onLeft: boolean) => (onLeft ? colOf(sq) <= 4 : colOf(sq) >= 5);
  const general = pick(sq => rowOf(sq) >= 7 && rowOf(sq) <= 8 && wing(sq, left));
  put(general, '9');
  put(pick(sq => rowOf(sq) >= 7 && neighbours(general).includes(sq)), 'S');
  put(pick(sq => rowOf(sq) >= 7 && rowOf(sq) <= 8 && wing(sq, !left)), '10');
  // Scouts: four on the front row where the files are open, the rest behind them.
  for (let i = 0; i < 8; i++) put(pick(i < 4 ? sq => rowOf(sq) === 6 && OPEN_FILES.has(colOf(sq)) : sq => rowOf(sq) === 7 || rowOf(sq) === 8), '2');
  // Miners stay back, spread out so no single raid takes them all.
  for (let i = 0; i < 5; i++) put(pick(sq => rowOf(sq) >= 8), '3');
  // Colonels and Majors hold the open files near the front.
  for (const rank of ['8', '8', '7', '7', '7'] as const) put(pick(sq => rowOf(sq) <= 7 && OPEN_FILES.has(colOf(sq))), rank);
  // Everything else fills the gaps.
  const rest = shuffled<Rank>(['6', '6', '6', '6', '5', '5', '5', '5', '4', '4', '4', '4']);
  for (const sq of [...free]) put(sq, rest.pop()!);
  if (color === 'red') return placement;
  return Object.fromEntries(Object.entries(placement).map(([sq, rank]) => [mirror(Number(sq)), rank]));
}

// ---------- Beliefs ----------
/** Prior weight of each rank for a piece that has never moved, by the depth of its row: back row first, front row last. */
const ROW_PRIOR: Record<Rank, readonly [number, number, number, number]> = {
  'F': [1, 0.3, 0.06, 0.02], 'B': [0.9, 1, 0.7, 0.55],
  '10': [0.5, 1, 1.2, 0.9], '9': [0.5, 1, 1.2, 0.9], '8': [0.6, 1, 1.2, 1], '7': [0.7, 1, 1.1, 1.1],
  '6': [0.8, 1, 1, 1.1], '5': [0.9, 1, 1, 1.1], '4': [1, 1, 1, 1.1], '3': [1.2, 1.1, 0.8, 0.6],
  '2': [0.6, 0.8, 1, 1.4], 'S': [0.9, 1.1, 1, 0.6],
};

/** How many enemy pieces of each rank are still unaccounted for: alive on the board with an unknown rank. */
export function hiddenCounts(sim: Sim, them: Color): Record<Rank, number> {
  const counts = Object.fromEntries(RANKS.map(r => [r, PIECE_BY_RANK[r].count])) as Record<Rank, number>;
  for (const rank of sim.captured[them]) counts[rank]--;
  for (const piece of sim.board) if (piece?.owner === them && piece.rank) counts[piece.rank]--;
  return counts;
}

/** Multipliers learned from how each enemy piece behaved next to pieces of ours whose rank it had seen: approaching a piece it would lose to, or fleeing one it would beat, is unlikely. */
function inferBehaviour(round: Round, sim: Sim, me: Color): Map<string, Distribution> {
  const mult = new Map<string, Distribution>();
  const bump = (id: string, unlikely: (rank: Rank) => boolean, factor: number) => {
    const m = mult.get(id) ?? (Object.fromEntries(RANKS.map(r => [r, 1])) as Distribution);
    for (const rank of MOVABLE) if (unlikely(rank)) m[rank] = Math.max(0.03, m[rank] * factor);
    mult.set(id, m);
  };
  const board: ({ owner: Color; id: string } | null)[] = Array(100).fill(null);
  for (const color of ['red', 'blue'] as const) for (const entry of round.setups[color] ?? []) board[entry.square] = { owner: color, id: entry.id };
  const known = new Map<string, Rank>();            // ranks of our movable pieces the enemy has seen
  const seen = (sq: number) => { const p = board[sq]; return p?.owner === me ? known.get(p.id) ?? null : null; };
  let combat = 0, pending: { from: number; to: number } | null = null;
  for (const event of round.log) {
    if (event.type === 'move') {
      const piece = board[event.from]!;
      if (board[event.to]) { pending = { from: event.from, to: event.to }; continue; }
      board[event.to] = piece; board[event.from] = null;
      if (piece.owner === me) { if (steps(event.from, event.to) > 1) known.set(piece.id, '2'); continue; }
      const before = NEIGHBOURS[event.from]!, after = NEIGHBOURS[event.to]!;
      for (const n of after) { const rank = seen(n); if (rank && !before.includes(n)) bump(piece.id, r => resolveCombat(r, rank) !== 'attacker', 0.3); }
      for (const n of before) { const rank = seen(n); if (rank && !after.includes(n)) bump(piece.id, r => resolveCombat(r, rank) === 'attacker', 0.6); }
      continue;
    }
    if (event.type === 'defend' && pending) {
      const c = sim.combats[combat++]!;
      const attacker = board[pending.from]!, defender = board[pending.to]!;
      if (c.result === 'attacker' || c.result === 'flag') { board[pending.to] = attacker; board[pending.from] = null; }
      else if (c.result === 'defender') board[pending.from] = null;
      else { board[pending.from] = null; board[pending.to] = null; }
      const [mine, rank] = attacker.owner === me ? [attacker, c.attacker.rank] : [defender, c.defender.rank];
      if (PIECE_BY_RANK[rank].movable) known.set(mine.id, rank);
      pending = null;
    }
  }
  return mult;
}

/** Probability of each rank for every unknown enemy piece, keyed by square. */
export function beliefs(round: Round, sim: Sim, me: Color): Map<number, Distribution> {
  const them = other(me);
  const hidden = hiddenCounts(sim, them);
  const unknown: number[] = [];
  sim.board.forEach((p, sq) => { if (p?.owner === them && !p.rank) unknown.push(sq); });
  const behaviour = inferBehaviour(round, sim, me);
  const weights = unknown.map(sq => {
    const piece = sim.board[sq]!, depth = Math.min(3, depthOf(them, sq)), learned = behaviour.get(piece.id);
    const w = zero();
    for (const rank of RANKS) {
      let v = hidden[rank] > 0 ? 1 : 0;
      if (piece.moved) { if (rank === 'B' || rank === 'F') v = 0; }
      else {
        v *= ROW_PRIOR[rank][depth]!;
        if (rank === 'B' && depth === 3 && LAKE_FILES.has(colOf(sq))) v *= 1.5;   // cannot move forward: a favourite bomb spot
        if (rank === 'F') v *= NEIGHBOURS[sq]!.every(n => sim.board[n]?.owner === them && !sim.board[n]!.moved) ? 2.5 : 0.4;   // flags are boxed in by pieces that never move
      }
      w[rank] = v * (learned?.[rank] ?? 1);
    }
    return w;
  });
  // Iterative proportional fitting: each piece's probabilities sum to 1 while each rank's expected count matches what is still hidden.
  for (let iter = 0; iter < 25; iter++) {
    for (const rank of RANKS) {
      let total = 0;
      for (const w of weights) total += w[rank];
      if (total > 0) { const k = hidden[rank] / total; for (const w of weights) w[rank] *= k; }
    }
    for (const w of weights) { let total = 0; for (const r of RANKS) total += w[r]; if (total > 0) for (const r of RANKS) w[r] /= total; }
  }
  return new Map(unknown.map((sq, i) => [sq, weights[i]!]));
}

// ---------- Search ----------
// The search works on a compact copy of the board: ranks are indices into
// RANKS, moves are `from * 100 + to`, and combat, distance and movement come
// from tables built once from the engine's own rules.
const N = RANKS.length;
const R = Object.fromEntries(RANKS.map((r, i) => [r, i])) as Record<Rank, number>;
const MARSHAL = R['10'], GENERAL = R['9'], MINER = R['3'], SCOUT = R['2'], SPY = R['S'], BOMB = R['B'], FLAG = R['F'];
const VALUE = RANKS.map(r => PIECE_BY_RANK[r].value);
const IS_MOVABLE = RANKS.map(r => PIECE_BY_RANK[r].movable);
/** Combat outcome by attacker and defender index: 0 attacker wins, 1 defender wins, 2 both die, 3 flag taken. */
const OUTCOME = new Int8Array(N * N);
for (const a of RANKS) for (const d of RANKS) if (PIECE_BY_RANK[a].movable) OUTCOME[R[a] * N + R[d]] = ['attacker', 'defender', 'both', 'flag'].indexOf(resolveCombat(a, d));
/** Material value by rank index, before the adjustments in `values`. */
const BASE = RANKS.map(r => ({ '10': 550, '9': 400, '8': 250, '7': 150, '6': 95, '5': 60, '4': 45, '3': 80, '2': 25, 'S': 45, 'B': 40, 'F': 0 })[r]);
const DIST = new Int8Array(10000);
for (let a = 0; a < 100; a++) for (let b = 0; b < 100; b++) DIST[a * 100 + b] = distance(a, b);
/** Squares two and three steps away from each square (lakes excluded): where a piece can be chased from, or run to. */
const NEAR: readonly (readonly number[])[][] = Array.from({ length: 100 }, (_, sq) => [2, 3].map(d => Array.from({ length: 100 }, (_, t) => t).filter(t => !LAKES.has(t) && DIST[sq * 100 + t] === d)));
const ADVANCE: Record<Color, Int8Array> = { red: new Int8Array(100), blue: new Int8Array(100) };
for (let sq = 0; sq < 100; sq++) { ADVANCE.red[sq] = advance('red', sq); ADVANCE.blue[sq] = advance('blue', sq); }
/** Squares reachable from each square in each direction, in order, stopping at the edge or a lake. */
const RAYS: number[][][] = Array.from({ length: 100 }, (_, sq) => [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dr, dc]) => {
  const ray: number[] = [];
  for (let r = rowOf(sq) + dr!, c = colOf(sq) + dc!; r >= 0 && r < 10 && c >= 0 && c < 10 && !LAKES.has(r * 10 + c); r += dr!, c += dc!) ray.push(r * 10 + c);
  return ray;
}));
const WIN = 100000;
/** A win or loss found by the search counts as this much material on top of the position: worth a lot, but a guess about a sampled flag never outweighs the whole army. */
const CAP = 600;
/** What taking the flag is worth at the root, where the odds are exact: a suspected flag is worth a Scout at long odds, an officer only when the flag is likelier than a bomb, and the Marshal or General only when it is nearly certain. */
const capFor = (attacker: number, dist: Distribution) => (BASE[attacker]! >= 150 && dist.F < dist.B ? 0 : attacker === MARSHAL || attacker === GENERAL ? 300 : 1200);

interface Cell { owner: Color; rank: number; moved: boolean; revealed: boolean; id: string }
interface Board { cells: (Cell | null)[]; recent: Record<Color, Recent[]>; winner: Color | null; flags: Record<Color, number> }
interface Undo { from: number; to: number; piece: Cell; target: Cell | null; moved: boolean; revealed: boolean; targetRevealed: boolean; pushed: boolean; dropped: Recent | undefined; winner: Color | null }
class Timeout extends Error {}
let nodes = 0, deadline = Infinity;
/** What the last search did, for tuning and tests. */
export const stats = { depth: 0, nodes: 0, ms: 0, moves: 0 };

/** The engine's two-square rule on the search board's move list. */
function blocked(recent: readonly Recent[], id: string, from: number, to: number) {
  if (recent.length < 3) return false;
  for (let i = recent.length - 3; i < recent.length; i++) {
    const m = recent[i]!;
    if (m.id !== id || !((m.a === from && m.b === to) || (m.a === to && m.b === from))) return false;
  }
  return true;
}
function generate(b: Board, side: Color): number[] {
  const out: number[] = [], recent = b.recent[side], cells = b.cells;
  for (let sq = 0; sq < 100; sq++) {
    const p = cells[sq];
    if (!p || p.owner !== side || !IS_MOVABLE[p.rank]) continue;
    const scout = p.rank === SCOUT, rays = RAYS[sq]!;
    for (let d = 0; d < 4; d++) {
      const ray = rays[d]!;
      for (let i = 0; i < ray.length; i++) {
        const to = ray[i]!, t = cells[to];
        if (t?.owner === side) break;
        if (!blocked(recent, p.id, sq, to)) out.push(sq * 100 + to);
        if (t || !scout) break;
      }
    }
  }
  return out;
}
/** Captures first, best first, so alpha-beta prunes early. */
function ordered(b: Board, side: Color): number[] {
  const list = generate(b, side), cells = b.cells;
  const captures: number[] = [], keys: number[] = [], quiet: number[] = [];
  for (const m of list) {
    const t = cells[m % 100];
    if (!t) { quiet.push(m); continue; }
    const o = OUTCOME[cells[(m / 100) | 0]!.rank * N + t.rank];
    const key = o === 3 ? 1e6 : o === 0 ? 1000 + BASE[t.rank]! : o === 2 ? 500 : 1;
    let i = 0;
    while (i < keys.length && keys[i]! >= key) i++;
    keys.splice(i, 0, key); captures.splice(i, 0, m);
  }
  return captures.concat(quiet);
}

const CNT: Record<Color, Int32Array> = { red: new Int32Array(N), blue: new Int32Array(N) };
const VAL: Record<Color, Float64Array> = { red: new Float64Array(N), blue: new Float64Array(N) };
/** The value of each rank for one side given what both armies still hold. */
function values(mine: Int32Array, theirs: Int32Array, out: Float64Array) {
  let theirTop = 0;
  for (let r = 0; r < N; r++) { out[r] = BASE[r]!; if (IS_MOVABLE[r] && r !== SPY && theirs[r]! > 0) theirTop = Math.max(theirTop, VALUE[r]!); }
  if (theirs[MARSHAL]! > 0) out[SPY] = out[SPY]! + 170;                                   // the only answer to their Marshal
  if (theirs[BOMB]! > 0) out[MINER] = out[MINER]! + 70 + Math.max(0, 5 - mine[MINER]!) ** 2 * 20;   // the only way through their bombs, so without them the game cannot be won: precious, and the last ones nearly priceless
  if (theirs[SPY] === 0) out[MARSHAL] = out[MARSHAL]! + 60;                                    // nothing movable can touch it any more
  for (let r = 0; r < N; r++) if (IS_MOVABLE[r] && r !== SPY) { if (VALUE[r]! > theirTop) out[r] = out[r]! + 60; else if (VALUE[r] === theirTop) out[r] = out[r]! + 20; }
}
/** Whether a side's flag has one of its own bombs on every open side. */
function sealed(b: Board, c: Color) {
  const flag = b.flags[c];
  return flag >= 0 && NEIGHBOURS[flag]!.every(n => b.cells[n]?.owner === c && b.cells[n]!.rank === BOMB);
}
/** Static evaluation from the point of view of the side to move. */
function evaluate(b: Board, side: Color): number {
  const cells = b.cells;
  CNT.red.fill(0); CNT.blue.fill(0);
  const marshal = { red: -1, blue: -1 }, general = { red: -1, blue: -1 };
  for (let sq = 0; sq < 100; sq++) {
    const p = cells[sq];
    if (!p) continue;
    CNT[p.owner][p.rank] = CNT[p.owner][p.rank]! + 1;
    if (p.rank === MARSHAL) marshal[p.owner] = sq; else if (p.rank === GENERAL) general[p.owner] = sq;
  }
  values(CNT.red, CNT.blue, VAL.red); values(CNT.blue, CNT.red, VAL.blue);
  let moversRed = 0, moversBlue = 0;
  for (let r = 0; r < N; r++) if (IS_MOVABLE[r]) { moversRed += CNT.red[r]!; moversBlue += CNT.blue[r]!; }
  const sealedRed = sealed(b, 'red'), sealedBlue = sealed(b, 'blue');
  let huntRed = 99, huntBlue = 99;      // nearest useful red hunter to the blue flag, and the reverse
  let threatRed = 0, threatBlue = 0;    // the best capture each side has waiting
  let score = 0;                        // positive for red
  for (let sq = 0; sq < 100; sq++) {
    const p = cells[sq];
    if (!p) continue;
    const r = p.rank, red = p.owner === 'red', enemy = red ? 'blue' : 'red';
    let v = (red ? VAL.red : VAL.blue)[r]!;
    if (IS_MOVABLE[r]) {
      const enemyMovers = red ? moversBlue : moversRed, theirMarshal = marshal[enemy];
      // Miners stay home while the enemy army is still out in force; every piece that has never moved keeps the enemy guessing where the bombs are.
      if (r !== MINER || enemyMovers <= 6) v += ADVANCE[p.owner][sq]!;
      if (!p.moved) v += 3;
      if (!p.revealed) v += r === MARSHAL || r === GENERAL ? 15 : r === SPY ? (theirMarshal >= 0 ? 40 : 5) : 4;
      if (r === SPY && theirMarshal >= 0) {
        // The Spy guards the General (a Marshal that takes the General dies next move) and stalks a revealed Marshal from two squares away,
        // where the Marshal cannot strike first but one careless step brings it within reach.
        const own = general[p.owner];
        if (own >= 0) { const d = DIST[sq * 100 + own]!; if (d === 1) v += 20; else if (d === 2) v += 8; }
        if (cells[theirMarshal]!.revealed) { const d = DIST[sq * 100 + theirMarshal]!; if (d === 2) v += 35; else if (d === 3) v += 15; }
      }
      const enemyVals = red ? VAL.blue : VAL.red, ns = NEIGHBOURS[sq]!;
      for (let i = 0; i < ns.length; i++) {
        const t = cells[ns[i]!];
        if (!t || t.owner === p.owner) continue;
        const o = OUTCOME[r * N + t.rank];
        // A flag within reach is (nearly) a win; but flags in the search are mostly guesses, so the top pieces do not chase them into bombs.
        const gain = o === 3 ? (r === MARSHAL || r === GENERAL ? 600 : 2000) : o === 0 ? enemyVals[t.rank]! : 0;
        if (red) { if (gain > threatRed) threatRed = gain; } else if (gain > threatBlue) threatBlue = gain;
      }
      // Two or three squares away: close in on enemies this piece beats (intruders deep in our half above all), keep away from enemies that beat it —
      // mostly when they know what it is, except Miners, which run from everything: without them the game cannot be won.
      const near = NEAR[sq]!;
      for (let d = 0; d < 2; d++) {
        const ring = near[d]!, w = d === 0 ? 0.1 : 0.05;
        for (let i = 0; i < ring.length; i++) {
          const t = cells[ring[i]!];
          if (!t || t.owner === p.owner || !IS_MOVABLE[t.rank]) continue;
          if (OUTCOME[r * N + t.rank] === 0) v += enemyVals[t.rank]! * w * (ADVANCE[t.owner][ring[i]!]! >= 6 ? 2.5 : 1);
          if (OUTCOME[t.rank * N + r] === 0) v -= v * (r === MINER ? 2 * w : w * (p.revealed ? 1 : 0.4));
        }
      }
      const flag = red ? b.flags.blue : b.flags.red;
      if (flag >= 0 && ((red ? sealedBlue : sealedRed) ? r === MINER && enemyMovers <= 12 : r !== SPY)) {
        const d = DIST[sq * 100 + flag]!;
        if (red) { if (d < huntRed) huntRed = d; } else if (d < huntBlue) huntBlue = d;
      }
    }
    score += red ? v : -v;
  }
  const pull = (hunt: number, movers: number) => (hunt === 99 ? 0 : Math.max(0, 30 - 3 * hunt) * (movers <= 6 ? 3 : movers <= 12 ? 2 : 1));   // the fewer defenders, the more the flag pulls
  score += pull(huntRed, moversBlue) - pull(huntBlue, moversRed);
  score += side === 'red' ? 0.5 * threatRed - 0.3 * threatBlue : 0.3 * threatRed - 0.5 * threatBlue;
  return side === 'red' ? score : -score;
}

function make(b: Board, move: number, side: Color): Undo {
  const from = (move / 100) | 0, to = move % 100;
  const piece = b.cells[from]!, target = b.cells[to] ?? null;
  const undo: Undo = { from, to, piece, target, moved: piece.moved, revealed: piece.revealed, targetRevealed: target?.revealed ?? false, pushed: false, dropped: undefined, winner: b.winner };
  const remember = () => { const recent = b.recent[side]; if (recent.length >= 3) undo.dropped = recent.shift(); recent.push({ id: piece.id, a: from, b: to }); undo.pushed = true; };
  if (!target) {
    b.cells[to] = piece; b.cells[from] = null; piece.moved = true;
    if (steps(from, to) > 1) piece.revealed = true;
    remember();
    return undo;
  }
  piece.revealed = true; target.revealed = true;
  const o = OUTCOME[piece.rank * N + target.rank];
  if (o === 3) { b.cells[to] = piece; b.cells[from] = null; b.winner = side; }
  else if (o === 0) { b.cells[to] = piece; b.cells[from] = null; piece.moved = true; remember(); }
  else if (o === 1) b.cells[from] = null;
  else { b.cells[from] = null; b.cells[to] = null; }
  return undo;
}
function unmake(b: Board, u: Undo, side: Color) {
  b.cells[u.from] = u.piece; b.cells[u.to] = u.target;
  u.piece.moved = u.moved; u.piece.revealed = u.revealed;
  if (u.target) u.target.revealed = u.targetRevealed;
  if (u.pushed) { const recent = b.recent[side]; recent.pop(); if (u.dropped) recent.unshift(u.dropped); }
  b.winner = u.winner;
}

function negamax(b: Board, side: Color, depth: number, alpha: number, beta: number, ply: number): number {
  nodes++;
  if (b.winner) return b.winner === side ? WIN - ply : ply - WIN;
  if (depth === 0) return evaluate(b, side);
  if ((nodes & 1023) === 0 && now() > deadline) throw new Timeout();
  const list = ordered(b, side);
  if (list.length === 0) return ply - WIN;
  let best = -Infinity;
  for (const m of list) {
    const undo = make(b, m, side);
    const v = -negamax(b, other(side), depth - 1, -beta, -alpha, ply + 1);
    unmake(b, undo, side);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/** One complete enemy army consistent with the beliefs: bombs and the flag go to pieces that never moved, everything else is drawn without replacement. */
function sample(sim: Sim, belief: Map<number, Distribution>, hidden: Record<Rank, number>): Board {
  const cells: (Cell | null)[] = sim.board.map(p => p && { owner: p.owner, rank: p.rank ? R[p.rank] : -1, moved: p.moved, revealed: p.revealed, id: p.id });
  const counts = { ...hidden };
  const open = new Set(belief.keys());
  const give = (sq: number, rank: Rank) => { cells[sq]!.rank = R[rank]; counts[rank]--; open.delete(sq); };
  for (const rank of ['F', 'B'] as const) {
    while (counts[rank] > 0) {
      const sq = weighted([...open], s => belief.get(s)![rank]);
      if (sq === null) break;
      give(sq, rank);
    }
  }
  for (const sq of shuffled([...open])) give(sq, weighted(RANKS, r => (counts[r] > 0 ? belief.get(sq)![r] : 0)) ?? RANKS.find(r => counts[r] > 0)!);
  const flags = { red: -1, blue: -1 };
  cells.forEach((p, sq) => { if (p?.rank === FLAG) flags[p.owner] = sq; });
  return { cells, recent: { red: [...sim.recent.red], blue: [...sim.recent.blue] }, winner: null, flags };
}

/** Squares the bot left in its last few moves: wandering back to them is dithering, not progress. */
function recentlyLeft(round: Round, me: Color, to: number): number {
  let count = 0, seen = 0;
  for (let i = round.log.length - 1; i >= 0 && seen < 12; i--) {
    const event = round.log[i]!;
    if (event.type !== 'move' || event.by !== me) continue;
    seen++;
    if (event.from === to) count++;
  }
  return count;
}


/** The move to play, or null when there is none. */
export function chooseMove(input: BotInput): Move | null {
  const { round, sim, me } = input;
  const { timeMs = 500, samples = 8, maxDepth = 4 } = input.options ?? {};
  const them = other(me);
  const legal: Move[] = [];
  for (let sq = 0; sq < 100; sq++) if (sim.board[sq]?.owner === me) for (const to of targets(sim.board, sq, sim.recent[me])) legal.push({ from: sq, to });
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0]!;
  const started = now();
  deadline = Infinity; nodes = 0;
  const belief = beliefs(round, sim, me);
  const hidden = hiddenCounts(sim, them);
  const boards = Array.from({ length: samples }, () => sample(sim, belief, hidden));
  const baselines = boards.map(b => evaluate(b, me));
  deadline = started + timeMs;

  /** The value of a root move in one sample, seen `depth` plies deep; a win or loss found on the way counts as CAP on top of the position as it stands. */
  const after = (b: Board, k: number, move: number, depth: number) => {
    const undo = make(b, move, me);
    const v = b.winner ? WIN : depth <= 1 ? -evaluate(b, them) : -negamax(b, them, depth - 1, -Infinity, Infinity, 1);
    unmake(b, undo, me);
    return v > WIN / 2 ? baselines[k]! + CAP : v < -WIN / 2 ? baselines[k]! - CAP : v;
  };
  /** Gives the unknown piece on `sq` the rank `rank` in this sample, swapping with a piece that holds it so the army stays consistent. Returns the undo. */
  const force = (b: Board, sq: number, rank: Rank): (() => void) => {
    const piece = b.cells[sq]!, was = piece.rank, index = R[rank];
    if (was === index) return () => {};
    const candidates = [...belief.keys()].filter(s => s !== sq && b.cells[s]?.rank === index && (IS_MOVABLE[was] || !b.cells[s]!.moved));
    const partner = candidates.length ? b.cells[candidates[rnd(candidates.length)]!]! : null;
    piece.rank = index;
    if (partner) partner.rank = was;
    return () => { piece.rank = was; if (partner) partner.rank = index; };
  };
  type Root = { move: Move; code: number; value: number; unknown: number | null };
  // Attacking a revealed piece that beats the attacker is suicide, whatever the search makes of the position.
  const suicide = (move: Move) => {
    const piece = sim.board[move.from]!, t = sim.board[move.to];
    if (!t) return false;
    if (t.rank) return resolveCombat(piece.rank!, t.rank) === 'defender';
    return piece.rank === '3' && t.moved;   // a Miner gambling on an unknown mover can only hope for a Scout or the Spy; it is the win condition, not a probe
  };
  const sensible = legal.filter(move => !suicide(move));
  const roots: Root[] = (sensible.length ? sensible : legal).map(move => ({ move, code: move.from * 100 + move.to, value: 0, unknown: sim.board[move.to] && !sim.board[move.to]!.rank ? move.to : null }));
  /** Average over the samples; an attack on an unknown piece is averaged exactly over every rank it could be. */
  const valueAt = (root: Root, depth: number) => {
    let total = 0;
    for (let k = 0; k < boards.length; k++) {
      const b = boards[k]!;
      if (root.unknown === null) { total += after(b, k, root.code, depth); continue; }
      const dist = belief.get(root.unknown)!;
      let expected = 0, mass = 0;
      for (const rank of RANKS) {
        const p = dist[rank];
        if (p < 0.01) continue;
        if (rank === 'F') { expected += p * (baselines[k]! + capFor(b.cells[root.move.from]!.rank, dist)); mass += p; continue; }
        const restore = force(b, root.unknown, rank);
        expected += p * after(b, k, root.code, depth); mass += p;
        restore();
      }
      total += mass > 0 ? expected / mass : after(b, k, root.code, depth);
    }
    return total / boards.length;
  };

  // Iterative deepening with a narrowing beam: every move gets a shallow look, the promising ones a deeper one.
  let candidates = roots, reached = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const beam = depth <= 2 ? candidates : candidates.slice(0, depth === 3 ? 12 : 6);
    try {
      const vals = beam.map(r => valueAt(r, depth));
      beam.forEach((r, i) => { r.value = vals[i]!; });
      candidates = [...beam].sort((a, b) => b.value - a.value);
      reached = depth;
    } catch (err) { if (err instanceof Timeout) break; throw err; }
    if (now() > deadline) break;
  }
  stats.depth = reached; stats.nodes = nodes; stats.ms = now() - started; stats.moves = legal.length;

  // Root-only adjustments the search cannot see: the information an attack buys, a cheaper piece that could probe instead, a dislike of wandering back and forth,
  // and piece discipline: every piece that moves for the first time tells the enemy it is not a bomb, so a few pieces do the work while the rest keep the secret.
  const prober = sim.board.some(p => p?.owner === me && (p.rank === '2' || p.rank === '4' || p.rank === '5'));
  const inPlay = sim.board.filter(p => p?.owner === me && p.moved).length;
  const backRows = (sq: number) => (me === 'red' ? sq >= 80 : sq < 20);
  /** A piece that may have to run, whatever it gives away by moving: an enemy beside it, a known stronger enemy two squares away, or — for a Miner — any enemy that close. */
  const pressed = (sq: number, rank: Rank) => NEIGHBOURS[sq]!.some(n => sim.board[n]?.owner === them)
    || NEAR[sq]![0]!.some(n => { const t = sim.board[n]; return t?.owner === them && (rank === '3' || (!!t.rank && resolveCombat(t.rank, rank) === 'attacker')); });
  let best: Root | null = null, bestScore = -Infinity;
  const traced: { move: Move; value: number; score: number }[] = [];
  for (const root of candidates) {
    let score = root.value + (Math.random() - 0.5) * 4;
    const piece = sim.board[root.move.from]!;
    if (root.unknown !== null) {
      const dist = belief.get(root.unknown)!, target = sim.board[root.unknown]!;
      const certainty = Math.max(...RANKS.map(r => dist[r]));
      score += (1 - certainty) * (piece.rank === '2' ? (target.moved ? 14 : 5) : 6);
      if (!target.moved && prober && BASE[R[piece.rank!]]! >= 150) score -= dist.B * BASE[R[piece.rank!]]!;   // a Scout or Miner should be the one to find out
    } else if (!sim.board[root.move.to]) {
      score -= 6 * recentlyLeft(round, me, root.move.to);
      if (!piece.moved && !pressed(root.move.from, piece.rank!)) score -= 12 + 3 * inPlay + (backRows(root.move.from) ? 15 : 0);
    }
    if (score > bestScore) { bestScore = score; best = root; }
    traced.push({ move: root.move, value: root.value, score });
  }
  input.trace?.(traced.sort((a, b) => b.score - a.score));
  return best!.move;
}
