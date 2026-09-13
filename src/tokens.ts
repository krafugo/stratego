// Shared rendering of army tokens: the board, the guide, battle reports and
// the tracker all draw pieces through this one function.
import { PIECE_BY_RANK, type Rank } from './pieces.ts';
import type { Color } from './game.ts';

export const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export const arrow = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const crest = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.4 5.2 5.6.6-4.2 3.9 1.1 5.6L12 15l-4.9 2.8 1.1-5.6L4 8.3l5.6-.6z"/><path d="M4 19.5h16v2H4z"/></svg>';
export const ordinal = (color: Color) => (color === 'red' ? 'Red' : 'Blue');

/** One army token. `rank` null renders the hidden back of an enemy piece. */
export function token(rank: Rank | null, color: Color, opts: { revealed?: boolean; moved?: boolean; size?: 'lg' | 'sm'; name?: boolean } = {}) {
  const info = rank ? PIECE_BY_RANK[rank] : null;
  const cls = ['piece', color, info ? '' : 'hidden', opts.revealed ? 'revealed' : '', opts.moved ? 'moved' : '', opts.size ?? ''].filter(Boolean).join(' ');
  const label = info ? `${ordinal(color)} ${info.name}${opts.revealed ? ', revealed' : ''}${opts.moved ? ', has moved' : ''}` : `${ordinal(color)} piece, unknown${opts.moved ? ', has moved' : ''}`;
  return `<span class="${cls}" role="img" aria-label="${e(label)}">${info ? `<b>${e(info.rank)}</b><i>${info.glyph}</i>${opts.name ? `<small>${e(info.name)}</small>` : ''}` : `<i class="crest">${crest}</i>`}</span>`;
}
