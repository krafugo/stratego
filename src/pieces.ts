// Piece catalogue for classic Stratego: 40 pieces per army, 12 kinds.
// Ranks are strings so the type survives JSON round-trips unchanged.
export type Rank = '10' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | '2' | 'S' | 'B' | 'F';

export interface PieceInfo {
  rank: Rank;
  name: string;
  /** Combat strength. Bombs and flags never attack, so they have no value. */
  value: number;
  count: number;
  movable: boolean;
  /** SVG markup (24×24 viewBox, currentColor) used as the insignia on the token. */
  glyph: string;
  summary: string;
  detail: string;
}

const path = (d: string, fill = true) => `<svg viewBox="0 0 24 24" aria-hidden="true">${fill ? `<path d="${d}"/>` : `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`}</svg>`;

export const PIECES: readonly PieceInfo[] = [
  { rank: '10', name: 'Marshal', value: 10, count: 1, movable: true,
    glyph: path('M3 17.5h18V20H3zM3 16l-.8-9 5.3 3.7L12 4l4.5 6.7L21.8 7 21 16z'),
    summary: 'Highest rank. Beats everything except a bomb.',
    detail: 'The Marshal wins every fight it starts, except against a bomb. Its only weakness: when a Spy attacks it, the Spy wins.' },
  { rank: '9', name: 'General', value: 9, count: 1, movable: true,
    glyph: path('M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.5l-5.9 3.2 1.2-6.6L2.5 9.5l6.6-.9z'),
    summary: 'Second in command. Loses only to the Marshal.',
    detail: 'Strong enough to sweep the board, but a Marshal defeats it. Use it once you suspect where the enemy Marshal is.' },
  { rank: '8', name: 'Colonel', value: 8, count: 2, movable: true,
    glyph: path('M12 3.5c-1.5 3-4.5 5.5-9.5 5.5 2 2.2 4.6 3.4 7.6 3.5L9 20h6l-1.1-7.5c3-.1 5.6-1.3 7.6-3.5-5 0-8-2.5-9.5-5.5z'),
    summary: 'Two senior officers for the front line.',
    detail: 'Colonels lead attacks against unknown pieces once the Scouts have probed. They fall only to the General and the Marshal.' },
  { rank: '7', name: 'Major', value: 7, count: 3, movable: true,
    glyph: path('M12 2.5l7.5 3v5.3c0 4.9-3.2 8.5-7.5 10.7-4.3-2.2-7.5-5.8-7.5-10.7V5.5z'),
    summary: 'Solid mid-ranked officers.',
    detail: 'Majors beat the whole lower half of the army. Good for capturing revealed Captains and Lieutenants.' },
  { rank: '6', name: 'Captain', value: 6, count: 4, movable: true,
    glyph: path('M4 7h16v3.5H4zM4 13.5h16V17H4z'),
    summary: 'Versatile, expendable, everywhere.',
    detail: 'Four Captains give you a workhorse for probing suspected low pieces without risking an officer.' },
  { rank: '5', name: 'Lieutenant', value: 5, count: 4, movable: true,
    glyph: path('M4 10.25h16v3.5H4z'),
    summary: 'Beats Sergeants, Miners, Scouts and Spies.',
    detail: 'Cheap enough to trade, strong enough to clear the pieces that guard a bomb line.' },
  { rank: '4', name: 'Sergeant', value: 4, count: 4, movable: true,
    glyph: path('M12 3.5l8 4.5-1.6 2.6L12 7.2 5.6 10.6 4 8zM12 10l8 4.5-1.6 2.6L12 13.7l-6.4 3.4L4 14.5zM12 16.5l8 4.5H4z'),
    summary: 'The lowest fighting rank that still wins some fights.',
    detail: 'Sergeants beat Miners, Scouts and Spies. Often used to screen more valuable pieces.' },
  { rank: '3', name: 'Miner', value: 3, count: 5, movable: true,
    glyph: path('M4.2 19.8l8.4-8.4M9 6.5c3-1.8 7.5-1.6 10 1.5-3-.4-6.2.4-8.5 2.5'),
    summary: 'The only piece that can defuse bombs.',
    detail: 'A Miner attacking a bomb removes it and takes the square. Guard your Miners: without them, a bombed-in flag is unreachable.' },
  { rank: '2', name: 'Scout', value: 2, count: 8, movable: true,
    glyph: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2"/></svg>`,
    summary: 'Moves any distance in a straight line.',
    detail: 'The only piece that can travel several squares per turn, like a rook, and it may attack at the end of that run. Moving more than one square reveals it as a Scout.' },
  { rank: 'S', name: 'Spy', value: 1, count: 1, movable: true,
    glyph: path('M12 2.5c-4.4 0-7.5 4-7.5 9.5v9.5h15V12c0-5.5-3.1-9.5-7.5-9.5zm0 5.5c1.9 0 3.3 1.9 3.3 4.4S13.9 16.8 12 16.8s-3.3-1.9-3.3-4.4S10.1 8 12 8z'),
    summary: 'Weakest piece, unless it attacks the Marshal.',
    detail: 'The Spy loses to everything that attacks it and to everything it attacks — except the Marshal. If the Spy strikes first, the Marshal is captured.' },
  { rank: 'B', name: 'Bomb', value: 0, count: 6, movable: false,
    glyph: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="14" r="7"/><path d="M15.5 8.5l2.5-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="18.8" cy="3.4" r="1.6"/></svg>`,
    summary: 'Never moves. Destroys any attacker except a Miner.',
    detail: 'A bomb stays where you place it all game. Any piece that attacks it is lost, unless that piece is a Miner. Bombs cannot attack.' },
  { rank: 'F', name: 'Flag', value: 0, count: 1, movable: false,
    glyph: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M7.5 4h11l-3.2 4.5 3.2 4.5h-11z"/></svg>`,
    summary: 'Capture the enemy flag to win.',
    detail: 'The flag cannot move. The game ends the moment any enemy piece attacks it. Hide it well, and remember an unmovable piece that never moves is easy to spot.' },
];

export const PIECE_BY_RANK: Readonly<Record<Rank, PieceInfo>> = Object.fromEntries(PIECES.map(p => [p.rank, p])) as Record<Rank, PieceInfo>;

/** The 40 ranks of one army, in catalogue order. */
export const ARMY: readonly Rank[] = PIECES.flatMap(p => Array.from({ length: p.count }, () => p.rank));

export const RANKS: readonly Rank[] = PIECES.map(p => p.rank);

export const isRank = (value: unknown): value is Rank => typeof value === 'string' && value in PIECE_BY_RANK;

export const pieceName = (rank: Rank) => PIECE_BY_RANK[rank].name;

/** Short label shown on the token: numerals for officers, letters for special pieces. */
export const rankLabel = (rank: Rank) => rank;
