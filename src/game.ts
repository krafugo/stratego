// Deterministic Stratego engine shared by both peers.
//
// Neither browser is trusted with the other's army. Each player publishes
// only piece ids, positions and a commitment per piece; ranks travel across
// the wire solely as verifiable reveals (attacks, defences, scout runs, and a
// full reveal when a player has no legal move). Both peers replay the same
// event log and reject any transcript that breaks the rules.
import { ARMY, PIECE_BY_RANK, isRank, type Rank } from './pieces.ts';
import { commitment, isHex, randomHex, shuffle } from './crypto.ts';

export type Color = 'red' | 'blue';
export type Role = 'host' | 'guest';
export const SIZE = 10;
export const LAKES: ReadonlySet<number> = new Set([42, 43, 46, 47, 52, 53, 56, 57]);
export const MAX_ROUNDS = 100;
const MAX_EVENTS = 4000;
const COLORS: readonly Color[] = ['red', 'blue'];

export const other = (color: Color): Color => (color === 'red' ? 'blue' : 'red');
/** Red moves first. The host is red in even rounds, the guest in odd rounds. */
export const colorFor = (role: Role, round: number): Color => ((role === 'host') === (round % 2 === 0) ? 'red' : 'blue');
export const rowOf = (square: number) => Math.floor(square / SIZE);
export const colOf = (square: number) => square % SIZE;
export const isHomeSquare = (color: Color, square: number) => (color === 'red' ? square >= 60 : square < 40) && square >= 0 && square < 100;
export const homeSquares = (color: Color) => Array.from({ length: 40 }, (_, i) => (color === 'red' ? 60 : 0) + i);

export interface Reveal { rank: Rank; salt: string }
export interface SetupEntry { id: string; square: number; commitment: string }
export type GameEvent =
  | { type: 'move'; by: Color; from: number; to: number; reveal?: Reveal }
  | { type: 'defend'; by: Color; reveal: Reveal }
  | { type: 'stuck'; by: Color; reveals: Record<string, Reveal> };
export interface Round {
  setups: Partial<Record<Color, SetupEntry[]>>;
  log: GameEvent[];
  resigned: Partial<Record<Color, true>>;
  again: Partial<Record<Color, true>>;
}
export interface PrivateRound { ranks: Record<string, Rank>; salts: Record<string, string> }
export interface Saved { rounds: Round[]; private: Record<string, PrivateRound> }

export interface Piece { id: string; owner: Color; rank: Rank | null; revealed: boolean; moved: boolean }
export type CombatResult = 'attacker' | 'defender' | 'both' | 'flag';
export interface Combat { turn: number; from: number; square: number; attacker: { owner: Color; rank: Rank }; defender: { owner: Color; rank: Rank }; result: CombatResult }
interface Recent { id: string; a: number; b: number }
interface PendingReveal { owner: Color; id: string; rank: Rank; salt: string; index: number }
export interface Sim {
  board: (Piece | null)[];
  turn: Color;
  pending: { from: number; to: number } | null;
  captured: Record<Color, Rank[]>;
  combats: Combat[];
  lastMove: { from: number; to: number; by: Color } | null;
  winner: Color | null;
  reason: string;
  recent: Record<Color, Recent[]>;
  moveCount: number;
  reveals: PendingReveal[];
}

export class GameError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GameError(message);
}
const emptyRound = (): Round => ({ setups: {}, log: [], resigned: {}, again: {} });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isSquare = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 100;

export function resolveCombat(attacker: Rank, defender: Rank): CombatResult {
  if (defender === 'F') return 'flag';
  if (defender === 'B') return attacker === '3' ? 'attacker' : 'defender';
  if (attacker === 'S' && defender === '10') return 'attacker';
  const a = PIECE_BY_RANK[attacker].value, d = PIECE_BY_RANK[defender].value;
  return a > d ? 'attacker' : a < d ? 'defender' : 'both';
}

/** The two-square rule: a piece may not shuttle between the same two squares for a fourth consecutive move. */
export function shuttleBlocked(recent: readonly Recent[], id: string, from: number, to: number) {
  if (recent.length < 3) return false;
  return recent.slice(-3).every(m => m.id === id && ((m.a === from && m.b === to) || (m.a === to && m.b === from)));
}

/** Squares between two aligned squares, exclusive. Empty when they are not aligned. */
function pathBetween(from: number, to: number): number[] | null {
  const dr = Math.sign(rowOf(to) - rowOf(from)), dc = Math.sign(colOf(to) - colOf(from));
  if ((dr !== 0 && dc !== 0) || from === to) return null;
  const path: number[] = [];
  for (let sq = from + dr * SIZE + dc; sq !== to; sq += dr * SIZE + dc) path.push(sq);
  return path;
}

/** Legal destinations for the piece on `from`, given what is known about its rank. Unknown ranks are treated as ordinary movers. */
export function targets(board: readonly (Piece | null)[], from: number, recent: readonly Recent[] = []): number[] {
  const piece = board[from];
  if (!piece || piece.rank === 'B' || piece.rank === 'F') return [];
  const out: number[] = [];
  const r = rowOf(from), c = colOf(from), scout = piece.rank === '2';
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE; rr += dr, cc += dc) {
      const sq = rr * SIZE + cc;
      if (LAKES.has(sq)) break;
      const occupant = board[sq];
      if (occupant) { if (occupant.owner !== piece.owner) out.push(sq); break; }
      out.push(sq);
      if (!scout) break;
    }
  }
  return out.filter(to => !shuttleBlocked(recent, piece.id, from, to));
}

const hasAnyMove = (sim: Sim, color: Color) => sim.board.some((piece, sq) => piece?.owner === color && targets(sim.board, sq, sim.recent[color]).length > 0);

function checkSetup(color: Color, setup: unknown): asserts setup is SetupEntry[] {
  assert(Array.isArray(setup) && setup.length === 40, 'An army must have exactly 40 pieces.');
  const ids = new Set<string>(), squares = new Set<number>();
  for (const entry of setup as unknown[]) {
    assert(entry && typeof entry === 'object', 'Malformed setup.');
    const { id, square, commitment: hash } = entry as Record<string, unknown>;
    assert(typeof id === 'string' && /^\d{1,2}$/.test(id) && Number(id) < 40 && !ids.has(id), 'Malformed piece id.');
    assert(isSquare(square) && isHomeSquare(color, square) && !squares.has(square), 'Pieces must fill the four home rows.');
    assert(isHex(hash, 64), 'Malformed piece commitment.');
    ids.add(id); squares.add(square);
  }
}
function checkReveal(reveal: unknown): asserts reveal is Reveal {
  assert(reveal && typeof reveal === 'object' && isRank((reveal as Reveal).rank) && isHex((reveal as Reveal).salt, 32), 'Malformed reveal.');
}
function checkEvent(event: unknown): asserts event is GameEvent {
  assert(event && typeof event === 'object', 'Malformed event.');
  const e = event as Record<string, unknown>;
  assert(e.by === 'red' || e.by === 'blue', 'Malformed event.');
  if (e.type === 'move') { assert(isSquare(e.from) && isSquare(e.to), 'Malformed move.'); if (e.reveal !== undefined) checkReveal(e.reveal); }
  else if (e.type === 'defend') checkReveal(e.reveal);
  else if (e.type === 'stuck') { assert(e.reveals && typeof e.reveals === 'object', 'Malformed reveal.'); for (const r of Object.values(e.reveals as object)) checkReveal(r); }
  else assert(false, 'Unknown event.');
}
function checkRound(round: unknown): asserts round is Round {
  assert(round && typeof round === 'object', 'Malformed round.');
  const r = round as Record<string, unknown>;
  assert(r.setups && typeof r.setups === 'object' && Array.isArray(r.log) && r.log.length <= MAX_EVENTS && r.resigned && typeof r.resigned === 'object' && r.again && typeof r.again === 'object', 'Malformed round.');
  for (const color of COLORS) {
    const setup = (r.setups as Record<string, unknown>)[color];
    if (setup !== undefined) checkSetup(color, setup);
    assert([undefined, true].includes((r.resigned as Record<string, unknown>)[color] as never) && [undefined, true].includes((r.again as Record<string, unknown>)[color] as never), 'Malformed round.');
  }
  for (const event of r.log) checkEvent(event);
}

/** Replays a round. Throws GameError on any illegal event. `known` holds the ranks this peer is entitled to know up front. */
export function simulate(round: Round, known: Partial<Record<Color, Record<string, Rank>>>): Sim {
  const sim: Sim = { board: Array<Piece | null>(100).fill(null), turn: 'red', pending: null, captured: { red: [], blue: [] }, combats: [], lastMove: null, winner: null, reason: '', recent: { red: [], blue: [] }, moveCount: 0, reveals: [] };
  for (const color of COLORS) {
    for (const entry of round.setups[color] ?? []) sim.board[entry.square] = { id: entry.id, owner: color, rank: known[color]?.[entry.id] ?? null, revealed: false, moved: false };
  }
  const started = COLORS.every(color => round.setups[color]);
  const alive = (color: Color) => sim.board.filter((p): p is Piece => p?.owner === color);
  const checkCounts = (color: Color) => {
    const seen: Partial<Record<Rank, number>> = {};
    for (const rank of [...sim.captured[color], ...alive(color).filter(p => p.rank).map(p => p.rank!)]) {
      seen[rank] = (seen[rank] ?? 0) + 1;
      assert(seen[rank]! <= PIECE_BY_RANK[rank].count, `Too many ${PIECE_BY_RANK[rank].name}s revealed. The transcript is inconsistent.`);
    }
  };
  const learn = (piece: Piece, reveal: Reveal, index: number) => {
    assert(!piece.rank || piece.rank === reveal.rank, 'A piece changed rank. The transcript is inconsistent.');
    if (!known[piece.owner]) sim.reveals.push({ owner: piece.owner, id: piece.id, rank: reveal.rank, salt: reveal.salt, index });
    piece.rank = reveal.rank; piece.revealed = true;
    checkCounts(piece.owner);
  };
  const remember = (color: Color, id: string, a: number, b: number) => { sim.recent[color] = [...sim.recent[color], { id, a, b }].slice(-3); };
  const finish = (winner: Color, reason: string) => { sim.winner = winner; sim.reason = reason; };
  round.log.forEach((event, index) => {
    assert(started && !sim.winner, 'Moves arrived before both armies were placed or after the game ended.');
    if (event.type === 'move') {
      assert(!sim.pending && event.by === sim.turn, 'It is not that player’s turn.');
      const piece = sim.board[event.from];
      assert(piece && piece.owner === event.by, 'No piece of yours on that square.');
      const path = pathBetween(event.from, event.to);
      assert(path && !LAKES.has(event.to) && path.every(sq => !sim.board[sq] && !LAKES.has(sq)), 'Pieces move in straight lines across empty squares, never into a lake.');
      const target = sim.board[event.to];
      assert(target?.owner !== event.by, 'You cannot move onto your own piece.');
      if (event.reveal) learn(piece, event.reveal, index);
      assert(piece.rank !== 'B' && piece.rank !== 'F', 'Bombs and the flag never move.');
      if (path.length > 0) assert(piece.rank === '2', 'Only a Scout may move more than one square, and it must reveal itself.');
      assert(!shuttleBlocked(sim.recent[event.by], piece.id, event.from, event.to), 'Two-square rule: that piece must go somewhere else this turn.');
      if (target) { assert(piece.rank, 'An attacker must reveal its rank.'); sim.pending = { from: event.from, to: event.to }; return; }
      sim.board[event.to] = piece; sim.board[event.from] = null; piece.moved = true;
      remember(event.by, piece.id, event.from, event.to);
      sim.lastMove = { from: event.from, to: event.to, by: event.by }; sim.moveCount++; sim.turn = other(sim.turn);
      return;
    }
    if (event.type === 'defend') {
      assert(sim.pending && event.by === other(sim.turn), 'No attack is waiting for a defender.');
      const attacker = sim.board[sim.pending.from]!, defender = sim.board[sim.pending.to]!;
      learn(defender, event.reveal, index);
      const result = resolveCombat(attacker.rank!, defender.rank!);
      sim.combats.push({ turn: sim.moveCount + 1, from: sim.pending.from, square: sim.pending.to, attacker: { owner: attacker.owner, rank: attacker.rank! }, defender: { owner: defender.owner, rank: defender.rank! }, result });
      if (result === 'attacker' || result === 'flag') { sim.board[sim.pending.to] = attacker; sim.board[sim.pending.from] = null; attacker.moved = true; sim.captured[defender.owner].push(defender.rank!); remember(attacker.owner, attacker.id, sim.pending.from, sim.pending.to); }
      else if (result === 'defender') { sim.board[sim.pending.from] = null; sim.captured[attacker.owner].push(attacker.rank!); }
      else { sim.board[sim.pending.from] = null; sim.board[sim.pending.to] = null; sim.captured[attacker.owner].push(attacker.rank!); sim.captured[defender.owner].push(defender.rank!); }
      checkCounts(attacker.owner); checkCounts(defender.owner);
      sim.lastMove = { from: sim.pending.from, to: sim.pending.to, by: attacker.owner }; sim.moveCount++; sim.pending = null;
      if (result === 'flag') finish(attacker.owner, 'flag'); else sim.turn = other(sim.turn);
      return;
    }
    assert(!sim.pending && event.by === sim.turn, 'It is not that player’s turn.');
    const pieces = alive(event.by);
    assert(Object.keys(event.reveals).length === pieces.length && pieces.every(p => event.reveals[p.id]), 'A stuck player must reveal every remaining piece.');
    for (const piece of pieces) learn(piece, event.reveals[piece.id]!, index);
    const composition = [...sim.captured[event.by], ...pieces.map(p => p.rank!)].sort().join(',');
    assert(composition === [...ARMY].sort().join(','), 'The revealed army does not match a full Stratego army.');
    assert(!hasAnyMove(sim, event.by), 'That player still has a legal move.');
    finish(other(event.by), 'stuck');
  });
  if (!sim.winner) {
    const quit = COLORS.filter(color => round.resigned[color]);
    if (quit.length === 2) { sim.reason = 'draw'; }
    else if (quit.length === 1) finish(other(quit[0]!), 'resigned');
  }
  return sim;
}

export const roundOver = (round: Round, known: Partial<Record<Color, Record<string, Rank>>>) => { const sim = simulate(round, known); return !!sim.winner || sim.reason === 'draw'; };

/** A sensible random layout: flag on the back row wrapped in bombs, miners and the spy behind, everything else shuffled. */
export function randomSetup(color: Color): Record<number, Rank> {
  const back = color === 'red' ? 9 : 0, dir = color === 'red' ? -1 : 1;
  const free = new Set(homeSquares(color));
  const placement: Record<number, Rank> = {};
  const put = (square: number, rank: Rank) => { free.delete(square); placement[square] = rank; };
  const flagCol = crypto.getRandomValues(new Uint32Array(1))[0]! % SIZE;
  put(back * SIZE + flagCol, 'F');
  let bombs = 6;
  for (const [r, c] of [[back, flagCol - 1], [back, flagCol + 1], [back + dir, flagCol]]) {
    if (c! >= 0 && c! < SIZE && bombs > 0) { put(r! * SIZE + c!, 'B'); bombs--; }
  }
  const rear = shuffle([...free].filter(sq => rowOf(sq) === back || rowOf(sq) === back + dir));
  while (bombs-- > 0) put(rear.pop()!, 'B');
  const rearFirst: Rank[] = ['3', '3', '3', '3', '3', 'S'];
  const rest = shuffle(ARMY.filter(rank => !['F', 'B', ...rearFirst].includes(rank)));
  for (const rank of rearFirst) put(rear.pop()!, rank);
  const front = shuffle([...free]);
  for (const rank of rest) put(front.pop()!, rank);
  return placement;
}

export function checkPlacement(color: Color, placement: Record<number, Rank>) {
  const squares = Object.keys(placement).map(Number);
  assert(squares.length === 40 && squares.every(sq => isHomeSquare(color, sq)), 'Place all 40 pieces in your four home rows.');
  assert([...Object.values(placement)].sort().join(',') === [...ARMY].sort().join(','), 'That is not a complete army.');
}

export interface View {
  round: number; color: Color; phase: 'setup' | 'play' | 'over';
  mySetupDone: boolean; theirSetupDone: boolean;
  board: readonly (Piece | null)[]; turn: Color; myTurn: boolean; pending: { from: number; to: number } | null;
  captured: Record<Color, Rank[]>; combats: Combat[]; lastMove: Sim['lastMove']; lastCombat: Combat | null;
  winner: Color | null; outcome: 'win' | 'loss' | 'draw' | null; reason: string;
  myAgain: boolean; theirAgain: boolean; moveCount: number; alive: Record<Color, number>;
}

/** One room's game: a list of rounds plus this player's private ranks and salts. */
export class Game {
  rounds: Round[];
  private: Record<string, PrivateRound>;
  error = '';
  private queue: Promise<unknown> = Promise.resolve();
  room: string;
  role: Role;
  onChange: () => void;
  constructor(room: string, saved: Saved | null | undefined, onChange: () => void, role: Role) {
    this.room = room; this.role = role; this.onChange = onChange;
    this.rounds = saved?.rounds?.length ? saved.rounds : [emptyRound()];
    this.private = saved?.private ?? {};
  }
  get index() { return this.rounds.length - 1; }
  get round() { return this.rounds[this.index]!; }
  get color() { return colorFor(this.role, this.index); }
  saved(): Saved { return { rounds: this.rounds, private: this.private }; }
  snapshot(): { rounds: Round[] } { return { rounds: this.rounds }; }
  private known(index: number): Partial<Record<Color, Record<string, Rank>>> {
    const mine = this.private[index];
    return mine ? { [colorFor(this.role, index)]: mine.ranks } : {};
  }
  sim(index = this.index): Sim { return simulate(this.rounds[index]!, this.known(index)); }
  /** Serialises async work so a reveal cannot race an incoming sync. */
  task<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }
  view(): View {
    const round = this.round, color = this.color, sim = this.sim();
    const mySetupDone = !!round.setups[color], theirSetupDone = !!round.setups[other(color)];
    const phase = sim.winner || sim.reason === 'draw' ? 'over' : mySetupDone && theirSetupDone ? 'play' : 'setup';
    const board = sim.board.map(piece => piece && piece.owner !== color && !piece.revealed ? { ...piece, rank: null } : piece);
    return {
      round: this.index + 1, color, phase, mySetupDone, theirSetupDone, board, turn: sim.turn, myTurn: phase === 'play' && sim.turn === color && !sim.pending, pending: sim.pending,
      captured: sim.captured, combats: sim.combats, lastMove: sim.lastMove, lastCombat: sim.combats.at(-1) ?? null,
      winner: sim.winner, outcome: phase !== 'over' ? null : sim.winner === color ? 'win' : sim.winner ? 'loss' : 'draw', reason: sim.reason,
      myAgain: !!round.again[color], theirAgain: !!round.again[other(color)], moveCount: sim.moveCount,
      alive: { red: sim.board.filter(p => p?.owner === 'red').length, blue: sim.board.filter(p => p?.owner === 'blue').length },
    };
  }
  legalTargets(from: number): number[] {
    const sim = this.sim();
    const piece = sim.board[from];
    if (!piece || piece.owner !== this.color || sim.turn !== this.color || sim.pending || sim.winner) return [];
    return targets(sim.board, from, sim.recent[this.color]);
  }
  private changed() { this.onChange(); }

  async commitSetup(placement: Record<number, Rank>) {
    return this.task(async () => {
      assert(!this.round.setups[this.color], 'Your army is already placed.');
      checkPlacement(this.color, placement);
      const ids = shuffle(Array.from({ length: 40 }, (_, i) => String(i)));
      const ranks: Record<string, Rank> = {}, salts: Record<string, string> = {}, entries: SetupEntry[] = [];
      for (const [square, rank] of Object.entries(placement)) {
        const id = ids.pop()!, salt = randomHex(16);
        ranks[id] = rank; salts[id] = salt;
        entries.push({ id, square: Number(square), commitment: await commitment(id, rank, salt) });
      }
      entries.sort((a, b) => Number(a.id) - Number(b.id));
      this.private[this.index] = { ranks, salts };
      this.round.setups[this.color] = entries;
      this.changed();
    });
  }
  private reveal(id: string): Reveal { const mine = this.private[this.index]!; return { rank: mine.ranks[id]!, salt: mine.salts[id]! }; }
  private append(event: GameEvent) {
    const candidate: Round = { ...this.round, log: [...this.round.log, event] };
    simulate(candidate, this.known(this.index));
    this.round.log.push(event);
  }
  move(from: number, to: number) {
    assert(!this.error, this.error);
    const sim = this.sim();
    const piece = sim.board[from];
    assert(piece?.owner === this.color, 'Choose one of your own pieces.');
    assert(this.legalTargets(from).includes(to), 'That piece cannot move there.');
    const attack = !!sim.board[to], run = (pathBetween(from, to)?.length ?? 0) > 0;
    const event: GameEvent = { type: 'move', by: this.color, from, to };
    if (attack || run) event.reveal = this.reveal(piece.id);
    this.append(event);
    this.changed();
  }
  /** Answers an attack on one of our pieces, or declares that we cannot move. Safe to call at any time. */
  respond() {
    if (this.error) return false;
    const round = this.round;
    if (!COLORS.every(color => round.setups[color])) return false;
    const sim = this.sim();
    if (sim.winner || sim.reason === 'draw') return false;
    if (sim.pending && sim.board[sim.pending.to]?.owner === this.color && sim.turn !== this.color) {
      this.append({ type: 'defend', by: this.color, reveal: this.reveal(sim.board[sim.pending.to]!.id) });
      this.changed(); return true;
    }
    if (!sim.pending && sim.turn === this.color && !hasAnyMove(sim, this.color)) {
      const reveals: Record<string, Reveal> = {};
      for (const piece of sim.board) if (piece?.owner === this.color) reveals[piece.id] = this.reveal(piece.id);
      this.append({ type: 'stuck', by: this.color, reveals });
      this.changed(); return true;
    }
    return false;
  }
  resign() {
    if (this.round.resigned[this.color] || this.view().phase === 'over') return;
    this.round.resigned[this.color] = true;
    this.changed();
  }
  playAgain() {
    assert(this.view().phase === 'over', 'The round is still in progress.');
    assert(this.rounds.length < MAX_ROUNDS, 'This room has reached its round limit. Create a new room.');
    this.round.again[this.color] = true;
    this.startNextIfReady();
    this.changed();
  }
  private startNextIfReady() {
    const round = this.round;
    if (round.again.red && round.again.blue && roundOver(round, this.known(this.index)) && this.rounds.length < MAX_ROUNDS) this.rounds.push(emptyRound());
  }

  /** Merges the peer's transcript into ours after validating every new fact it contains. */
  async receive(incoming: unknown) {
    return this.task(async () => {
      if (this.error) return;
      try {
        assert(Array.isArray(incoming) && incoming.length > 0 && incoming.length <= MAX_ROUNDS, 'Malformed sync.');
        for (const round of incoming) checkRound(round);
        const theirs = incoming as Round[];
        const merged: Round[] = [];
        const toVerify: { index: number; reveal: PendingReveal }[] = [];
        for (let i = 0; i < Math.max(this.rounds.length, theirs.length); i++) {
          const mine = this.rounds[i], remote = theirs[i];
          if (!remote) { merged.push(mine!); continue; }
          if (!mine) {
            assert(i === merged.length && i > 0, 'Malformed sync.');
            const previous = merged[i - 1]!;
            assert(previous.again.red && previous.again.blue && roundOver(previous, this.known(i - 1)), 'A new round started before the last one ended.');
          }
          const me = colorFor(this.role, i), them = other(me);
          const next: Round = { setups: { ...mine?.setups }, log: [...(mine?.log ?? [])], resigned: { ...mine?.resigned }, again: { ...mine?.again } };
          for (const color of COLORS) {
            if (!remote.setups[color]) continue;
            if (next.setups[color]) assert(same(next.setups[color], remote.setups[color]), 'An army changed after it was placed. The transcript is inconsistent.');
            else { assert(color === them, 'The other player sent an army on your behalf.'); next.setups[color] = remote.setups[color]; }
            if (remote.resigned[color]) { assert(color === them || next.resigned[color], 'The other player resigned on your behalf.'); next.resigned[color] = true; }
            if (remote.again[color]) { assert(color === them || next.again[color], 'The other player answered on your behalf.'); next.again[color] = true; }
          }
          const known = next.log.length;
          for (let j = 0; j < remote.log.length; j++) {
            if (j < known) assert(same(next.log[j], remote.log[j]), 'The move history diverged. The transcript is inconsistent.');
            else { assert(remote.log[j]!.by === them, 'The other player moved on your behalf.'); next.log.push(remote.log[j]!); }
          }
          const sim = simulate(next, this.known(i));
          for (const reveal of sim.reveals) if (reveal.index >= known) toVerify.push({ index: i, reveal });
          merged.push(next);
        }
        for (const { index, reveal } of toVerify) {
          const entry = merged[index]!.setups[reveal.owner]?.find(e => e.id === reveal.id);
          assert(entry && entry.commitment === await commitment(reveal.id, reveal.rank, reveal.salt), 'A revealed piece did not match its commitment. The transcript is inconsistent.');
        }
        this.rounds = merged;
        this.startNextIfReady();
      } catch (error) {
        this.error = error instanceof GameError ? error.message : 'The game data could not be read.';
        this.changed();
        throw error;
      }
      this.changed();
      this.respond();
    });
  }
}
