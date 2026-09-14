import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { Game, GameError, LAKES, colOf, other, randomSetup, rowOf, type Color, type Combat, type Round, type View } from './game.ts';
import { PIECES, PIECE_BY_RANK, type Rank } from './pieces.ts';
import { arrow, crest, e, ordinal, token } from './tokens.ts';
import { guide } from './guide.ts';
import { RoomConnection, connectionOptions, createSession, normalizeCode, validCode, type Callbacks, type Session, type StatusKind } from './network.ts';
import { LocalConnection } from './local.ts';

registerSW({ immediate: true });

type Draft = { round: number; color: Color; placement: Record<number, Rank> };
type StoredSession = Session & { draft?: Draft; transport?: 'local'; savedAt?: number };
const SEAT_TTL = 7 * 24 * 60 * 60 * 1000;

const root = document.querySelector<HTMLElement>('#app')!;
const linkParams = new URLSearchParams(location.hash.slice(1));
// Dev only: `#seat=<name>` keeps two seats of the same browser apart while testing with the local transport.
const storageKey = 'stratego-session-v1' + (import.meta.env.DEV && linkParams.get('seat') ? ':' + linkParams.get('seat') : '');
// The seat (token, army ranks and salts) lives in localStorage so a killed tab,
// a backgrounded phone browser or a fresh open of the room link rejoins the
// same game. sessionStorage is the fallback when localStorage is blocked.
const storage: Storage | null = (() => {
  for (const candidate of [() => localStorage, () => sessionStorage]) {
    try { const store = candidate(); store.setItem('stratego-probe', '1'); store.removeItem('stratego-probe'); return store; } catch {}
  }
  return null;
})();
const linkRoom = normalizeCode(linkParams.get('room') ?? '');
let session: StoredSession | null = null, game: Game | null = null, network: RoomConnection | LocalConnection | null = null;
const localTransport = import.meta.env.DEV && linkParams.get('transport') === 'local';
let state: StatusKind | 'home' = 'home', status = '', message = '', fatal = '', busy = false;
let joining = !!linkParams.get('room');
let draftName = '', draftCode = linkParams.get('room') ?? '';
let selected: number | null = null, rulesOpen = false, leaveOpen = false, lastSent = '', storageWarning = '';
let resume: StoredSession | null = null;
try {
  const raw = JSON.parse(storage?.getItem(storageKey) ?? 'null');
  if (raw?.version === 1 && validCode(raw.code) && ['host', 'guest'].includes(raw.role) && raw.token && Date.now() - (raw.savedAt ?? Date.now()) < SEAT_TTL) resume = raw;
  else if (raw) storage?.removeItem(storageKey);
} catch {}

const FILES = 'ABCDEFGHIJ';
const squareName = (sq: number) => `${FILES[colOf(sq)]}${10 - rowOf(sq)}`;

function persist() {
  if (!session) return;
  if (game) session.game = game.saved();
  session.savedAt = Date.now();
  try { storage?.setItem(storageKey, JSON.stringify(session)); if (!storage) throw new Error('no storage'); }
  catch { storageWarning = 'This browser can’t save your game. Keep this tab open; refreshing or closing it will lose your place.'; }
}
function sync(force = false) {
  if (!game) return;
  const rounds = game.snapshot().rounds, text = JSON.stringify(rounds);
  if (force || text !== lastSent) { network?.send(rounds); lastSent = text; }
}
/** A peer that reconnects with an older transcript needs ours: true when theirs lacks something we hold. */
function peerIsBehind(theirs: unknown, ours: Round[]) {
  if (!Array.isArray(theirs) || theirs.length < ours.length) return true;
  return ours.some((round, i) => {
    const remote = theirs[i] as Partial<Round> | undefined;
    if (!remote) return true;
    return (remote.log?.length ?? 0) < round.log.length
      || (['red', 'blue'] as const).some(color => (round.setups[color] && !remote.setups?.[color]) || (round.resigned[color] && !remote.resigned?.[color]) || (round.again[color] && !remote.again?.[color]));
  });
}
function onGameChange() { persist(); sync(); render(); }

/** The arrangement being edited for the current round, created lazily and remembered across refreshes. */
function draft(v: View): Record<number, Rank> {
  const current = session!.draft;
  if (current && current.round === v.round && current.color === v.color) return current.placement;
  session!.draft = { round: v.round, color: v.color, placement: randomSetup(v.color) };
  persist();
  return session!.draft.placement;
}

async function start(role: 'host' | 'guest', existing: StoredSession | null = null) {
  if (busy) return;
  if (!crypto.subtle || !window.RTCPeerConnection) { message = 'Use a current browser on HTTPS (or localhost) to play.'; render(); return; }
  const code = normalizeCode(draftCode);
  if (!existing && role === 'guest' && !validCode(code)) { message = 'Enter the 8-character room code from your friend.'; render(); document.querySelector<HTMLInputElement>('#room-code')?.focus(); return; }
  busy = true; message = ''; render();
  try {
    const local = import.meta.env.DEV && (localTransport || existing?.transport === 'local');
    const options = local ? undefined : await connectionOptions();
    session = existing ?? createSession(role, draftName, role === 'guest' ? code : undefined);
    if (local) session.transport = 'local';
    state = 'connecting'; status = 'Opening a connection…'; selected = null; lastSent = '';
    game = new Game(session.code, session.game, onGameChange, session.role);
    try { game.view(); } catch { // a saved game this version cannot read: start the room over rather than boot into an error
      game = new Game(session.code, null, onGameChange, session.role); delete session.draft; message = 'The saved match could not be read, so this room starts a new round.';
    }
    const callbacks: Callbacks = {
      status(kind, text) { state = kind; status = text; render(); },
      ready(remote) { Object.assign(session!, { remoteName: remote.name, remoteToken: remote.token }); state = 'connected'; persist(); sync(true); game?.respond(); render(); },
      data(rounds) {
        game?.receive(rounds)
          .then(() => { if (game && peerIsBehind(rounds, game.snapshot().rounds)) sync(true); })
          .catch((err: unknown) => { fatal = err instanceof Error ? err.message : 'Sync failed.'; render(); });
      },
      error(text) { fatal = text; render(); },
    };
    network = local ? new LocalConnection(session, callbacks) : new RoomConnection(session, callbacks, options!);
    persist();
    window.history.replaceState(null, '', roomHash(session));
  } catch (err) { message = err instanceof Error ? err.message : 'Couldn’t open the room. Please try again.'; if (!network) { session = null; game = null; state = 'home'; } }
  busy = false; render();
}

const roomHash = (s: StoredSession) => '#' + new URLSearchParams({ room: s.code, ...(s.transport === 'local' ? { transport: 'local' } : {}), ...(import.meta.env.DEV && linkParams.get('seat') ? { seat: linkParams.get('seat')! } : {}) }).toString();
function inviteURL() { const url = new URL(location.href); url.hash = roomHash(session!); return url.href; }
async function copyInvite(share: boolean) {
  try {
    if (share && navigator.share) await navigator.share({ title: 'Stratego', text: 'Your army awaits. Join my game of Stratego!', url: inviteURL() });
    else { await navigator.clipboard.writeText(inviteURL()); message = 'Invite link copied. Send it to your friend.'; render(); }
  } catch (err) { if (!(err instanceof Error && err.name === 'AbortError')) { message = 'Copy the invite link below and send it to your friend.'; render(); document.querySelector<HTMLInputElement>('#invite-link')?.select(); } }
}

// ---------- Lobby ----------
function home() {
  const sample = [['10', 'red'], [null, 'blue'], ['3', 'red'], ['B', 'blue'], [null, 'blue'], ['2', 'red'], ['F', 'red'], [null, 'blue'], ['S', 'red']] as const;
  return `<div class="lobby-grid"><section class="start-panel"><div class="eyebrow"><span class="tiny-line"></span>A BATTLE OF WITS FOR TWO</div><h1>Hide the flag.<br><span>Read their army.</span></h1><p class="intro">Classic Stratego, browser to browser. Send a room code to a friend anywhere in the world and play on the same board — no account, no server, no downloads.</p>
    <div class="play-box">
      ${resume ? `<div class="resume"><div><strong>Your war room is still open</strong><p>${e(resume.code)} · ${e(resume.name)}</p></div><button class="button small" data-action="resume">Resume ${arrow}</button></div>` : ''}
      <div class="tabs" role="tablist" aria-label="Choose how to play"><button id="create-tab" role="tab" aria-selected="${!joining}" tabindex="${joining ? -1 : 0}" data-action="create-tab">Create a room</button><button id="join-tab" role="tab" aria-selected="${joining}" tabindex="${joining ? 0 : -1}" data-action="join-tab">Join a friend</button></div>
      <form id="play-form"><label for="player-name">Your name <span>optional</span></label><input id="player-name" name="name" autocomplete="nickname" maxlength="20" placeholder="General…" value="${e(draftName)}" />${joining ? `<label for="room-code">Room code</label><input id="room-code" class="code-input" name="room" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" placeholder="ABCD EFGH" value="${e(draftCode)}" required />` : ''}<button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : joining ? 'Join the battle' : 'Open a war room'} ${arrow}</button><p class="form-note">${joining ? 'Paste the code or open the link your friend sent you.' : 'You get a room code and a link to share with one friend.'}</p></form>
    </div><div class="lobby-meta"><span>Encrypted P2P</span><span>Verified reveals</span><span>No account</span></div></section>
  <aside class="intro-aside"><div class="sample-board"><div class="board-top"><span class="eyebrow">TWO ARMIES · ONE FLAG</span><span class="player-tag">40</span></div><div class="sample-grid">${sample.map(([rank, color]) => `<span class="sample-cell">${token(rank, color)}</span>`).join('')}</div><div class="sample-divider"></div><div class="sample-legend"><div>${token('10', 'red', { size: 'sm' })}<span>Your pieces show their rank</span></div><div>${token(null, 'blue', { size: 'sm' })}<span>Enemy ranks stay hidden until they fight</span></div></div></div><div class="quick-rules"><span class="eyebrow">HOW IT WORKS</span><h2>Every reveal is<br>cryptographically checked.</h2><p>Each army is committed with salted hashes before the first move. When a piece fights, its owner proves the rank against that commitment, so neither browser has to trust the other.</p><a class="text-button" href="#how-to-play" data-action="rules">How to play <span>↓</span></a></div></aside></div>
  <section id="how-to-play" class="how-to-play"><div class="section-heading"><h2>How to play</h2><span>Classic rules · 10 × 10 board</span></div>${guide()}</section>`;
}

// ---------- Room ----------
function inviteBox() {
  return `<div class="invite-box"><span class="eyebrow">ROOM CODE</span><div class="room-code">${e(session!.code.slice(0, 4))}<span> </span>${e(session!.code.slice(4))}</div><div class="invite-actions"><button class="button primary" data-action="share">Send invite ${arrow}</button><button class="button secondary" data-action="copy">Copy link</button></div><label class="sr-only" for="invite-link">Invite link</label><input id="invite-link" readonly value="${e(inviteURL())}" /></div>`;
}

function boardHTML(v: View) {
  const me = v.color, flip = me === 'blue', setup = v.phase === 'setup' && !v.mySetupDone;
  const placement = setup ? draft(v) : null;
  const targets = selected !== null && v.phase === 'play' ? new Set(game!.legalTargets(selected)) : new Set<number>();
  const combatSquare = v.lastCombat && v.lastMove && v.lastCombat.square === v.lastMove.to ? v.lastCombat.square : -1;
  let cells = '';
  for (let i = 0; i < 100; i++) {
    const sq = flip ? 99 - i : i;
    const piece = placement && placement[sq] ? { owner: me, rank: placement[sq]!, revealed: false, moved: false } : v.board[sq];
    const classes = ['cell'];
    if (LAKES.has(sq)) classes.push('lake');
    if (setup && (me === 'red' ? sq >= 60 : sq < 40)) classes.push('home');
    if (selected === sq) classes.push('selected');
    if (targets.has(sq)) classes.push(v.board[sq] ? 'capture' : 'target');
    if (v.lastMove && v.phase !== 'setup') { if (v.lastMove.from === sq) classes.push('from'); if (v.lastMove.to === sq) classes.push('to'); }
    if (combatSquare === sq) classes.push('battle');
    const label = `${squareName(sq)}${LAKES.has(sq) ? ', lake' : piece ? '' : ', empty'}`;
    const interactive = !LAKES.has(sq) && (setup ? !!piece && piece.owner === me : v.phase === 'play' && v.myTurn);
    cells += interactive
      ? `<button type="button" class="${classes.join(' ')}" data-square="${sq}" aria-label="${e(label)}" ${setup ? 'draggable="true"' : ''}>${piece ? token(piece.rank, piece.owner, { revealed: piece.revealed && piece.owner !== me, moved: piece.moved }) : ''}</button>`
      : `<div class="${classes.join(' ')}" data-square="${sq}" aria-label="${e(label)}">${piece ? token(piece.rank, piece.owner, { revealed: piece.revealed && piece.owner !== me, moved: piece.moved }) : ''}</div>`;
  }
  const files = [...FILES].map(f => `<span>${f}</span>`), ranks = Array.from({ length: 10 }, (_, i) => `<span>${10 - i}</span>`);
  if (flip) { files.reverse(); ranks.reverse(); }
  return `<div class="board-frame ${me}"><div class="ranks" aria-hidden="true">${ranks.join('')}</div><div class="board ${v.phase === 'play' && v.myTurn ? 'my-turn' : ''}" role="grid" aria-label="Stratego board">${cells}</div><div class="files" aria-hidden="true">${files.join('')}</div></div>`;
}

function describeCombat(c: Combat, me: Color) {
  const mine = c.attacker.owner === me, att = PIECE_BY_RANK[c.attacker.rank].name, def = PIECE_BY_RANK[c.defender.rank].name;
  const who = mine ? 'Your' : 'Their', whose = mine ? 'their' : 'your';
  if (c.result === 'flag') return mine ? `Your ${att} captured the enemy flag!` : `Their ${att} captured your flag.`;
  if (c.result === 'both') return `${who} ${att} and ${whose} ${def} destroyed each other.`;
  if (c.result === 'attacker') return c.defender.rank === 'B' ? `${who} Miner defused ${whose} bomb.` : `${who} ${att} captured ${whose} ${def}.`;
  return c.defender.rank === 'B' ? `${who} ${att} hit ${whose} bomb and was destroyed.` : `${who} ${att} was captured by ${whose} ${def}.`;
}
function battleCard(v: View) {
  const c = v.lastCombat;
  if (!c) return '';
  const winner = c.result === 'attacker' || c.result === 'flag' ? 'attacker' : c.result === 'defender' ? 'defender' : 'none';
  return `<div class="battle-card ${c.attacker.owner === v.color ? (winner === 'attacker' ? 'good' : winner === 'defender' ? 'bad' : '') : (winner === 'defender' ? 'good' : winner === 'attacker' ? 'bad' : '')}"><span class="eyebrow">LAST BATTLE · ${e(squareName(c.square))}</span><div class="battle-pieces"><div class="${winner === 'attacker' ? 'won' : winner === 'none' ? '' : 'lost'}">${token(c.attacker.rank, c.attacker.owner, { size: 'lg', name: true })}<small>attacked</small></div><span class="vs">⚔</span><div class="${winner === 'defender' ? 'won' : winner === 'none' ? '' : 'lost'}">${token(c.defender.rank, c.defender.owner, { size: 'lg', name: true })}<small>defended</small></div></div><p>${e(describeCombat(c, v.color))}</p></div>`;
}
function tracker(v: View) {
  const me = v.color, them = other(me);
  const lost = (color: Color, rank: Rank) => v.captured[color].filter(r => r === rank).length;
  const seen = (rank: Rank) => v.board.filter(p => p?.owner === them && p.revealed && p.rank === rank).length;
  return `<section class="tracker"><div class="section-heading"><h2>Army tracker</h2><span>${v.alive[them]} enemy · ${v.alive[me]} yours</span></div><table><thead><tr><th>Piece</th><th>Enemy left</th><th>Seen</th><th>Yours left</th></tr></thead><tbody>${PIECES.map(p => `<tr><td><span class="tracker-piece">${token(p.rank, them, { size: 'sm' })}<span>${e(p.name)}</span></span></td><td>${p.count - lost(them, p.rank)}</td><td>${seen(p.rank) || '–'}</td><td>${p.count - lost(me, p.rank)}</td></tr>`).join('')}</tbody></table></section>`;
}
function graveyard(v: View) {
  const me = v.color, them = other(me);
  const list = (color: Color) => v.captured[color].length ? v.captured[color].map(r => token(r, color, { size: 'sm' })).join('') : '<span class="none">None yet</span>';
  return `<div class="graveyard"><div><span class="eyebrow">THEIR LOSSES · ${v.captured[them].length}</span><div class="lost-row">${list(them)}</div></div><div><span class="eyebrow">YOUR LOSSES · ${v.captured[me].length}</span><div class="lost-row">${list(me)}</div></div></div>`;
}

function aside(v: View) {
  const friend = e(session!.remoteName ?? 'Your opponent'), hasFriend = !!session!.remoteToken, me = v.color;
  const seat = `<div class="seat-card"><div><span class="eyebrow">YOU COMMAND</span><strong>${e(session!.name)} · ${ordinal(me)}</strong></div><div><span class="eyebrow">ACROSS THE FIELD</span><strong>${hasFriend ? friend : 'Waiting to join'} · ${ordinal(other(me))}</strong></div></div>`;
  if (fatal || game!.error) return `<section class="game-panel"><div class="phase-label">GAME PAUSED</div><h1>Let’s start fresh.</h1><p>${e(fatal || game!.error)}</p><button class="button primary" data-action="leave">Back to the lobby ${arrow}</button></section>`;
  if (v.phase === 'setup') {
    const controls = v.mySetupDone
      ? `<div class="phase-label">ARMY LOCKED</div><h1>Waiting for ${hasFriend ? friend : 'your opponent'}.</h1><p>Your layout is committed and hidden. The battle starts as soon as both armies are in place.</p><div class="waiting-visual">${crest} Your 40 commitments are sealed.</div>`
      : `<div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · ARRANGE YOUR ARMY</div><h1>Set the field.</h1><p>Tap two pieces to swap them${matchMedia('(pointer:fine)').matches ? ', or drag them around' : ''}. Keep the flag behind bombs, scouts up front, and miners safe.</p><div class="setup-actions"><button class="button secondary" data-action="shuffle">Shuffle</button><button class="button primary" data-action="ready" ${busy ? 'disabled' : ''}>Ready for battle ${arrow}</button></div>${v.theirSetupDone ? `<div class="turn-notice action">${friend} is ready and waiting for you.</div>` : hasFriend ? `<div class="turn-notice">${friend} is still arranging their army.</div>` : ''}`;
    return `<section class="game-panel">${controls}<div class="message ${message ? '' : 'empty'}" role="status">${e(message)}</div></section>${hasFriend ? '' : inviteBox()}${seat}`;
  }
  if (v.phase === 'play') {
    const notice = v.pending ? '<div class="turn-notice waiting">⚔ Battle in progress · waiting for the defender</div>'
      : v.myTurn ? `<div class="turn-notice action">Your move${selected !== null ? ' · choose a highlighted square' : ' · tap one of your pieces'}</div>` : `<div class="turn-notice">${friend} is thinking…</div>`;
    return `<section class="game-panel"><div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · MOVE ${String(v.moveCount + 1).padStart(2, '0')}</div><h1>${v.myTurn ? 'Your move.' : v.pending ? 'Steel meets steel.' : `${friend}’s move.`}</h1>${notice}${battleCard(v)}<div class="message ${message ? '' : 'empty'}" role="status">${e(message)}</div><button class="text-button muted" data-action="resign">Resign this round</button></section>${graveyard(v)}${seat}`;
  }
  const title = v.outcome === 'win' ? 'Victory.' : v.outcome === 'loss' ? `${friend} wins.` : 'A draw.';
  const why = v.reason === 'flag' ? (v.outcome === 'win' ? 'You captured the enemy flag.' : 'Your flag was captured.') : v.reason === 'stuck' ? (v.outcome === 'win' ? `${friend} had no legal move left.` : 'You had no legal move left.') : v.reason === 'resigned' ? (v.outcome === 'win' ? `${friend} resigned.` : 'You resigned.') : 'Both players resigned.';
  return `<section class="game-panel result ${v.outcome}"><div class="phase-label">${v.outcome === 'win' ? 'YOU WIN THIS ROUND' : v.outcome === 'loss' ? `${friend.toUpperCase()} WINS` : 'IT’S A DRAW'}</div><h1>${title}</h1><p>${why} ${v.moveCount} moves were played.</p>${battleCard(v)}<button class="button primary" data-action="again" ${v.myAgain || state !== 'connected' ? 'disabled' : ''}>${v.myAgain ? `Waiting for ${friend}…` : v.theirAgain ? `${friend} wants a rematch · Play again` : 'Play again · colours swap'} ${arrow}</button><div class="message ${message ? '' : 'empty'}" role="status">${e(message)}</div></section>${graveyard(v)}${seat}`;
}

function room() {
  const v = game!.view();
  const top = `<div class="room-heading"><div><span class="eyebrow">ROOM</span><button class="room-pill" data-action="copy">${e(session!.code.slice(0, 4))} ${e(session!.code.slice(4))}<span>↗</span></button></div><button class="text-button muted" data-action="leave">Leave room</button></div><div class="connection-banner ${state === 'connected' ? 'connected' : ''}" role="status"><span class="connection-dot"></span><span>${e(status)}</span></div>${storageWarning ? `<div class="message">${e(storageWarning)}</div>` : ''}`;
  return `${top}<div class="game-grid">${boardHTML(v)}<aside class="game-aside">${aside(v)}</aside>${v.phase !== 'setup' ? tracker(v) : ''}</div>`;
}

function dialogs() {
  return `<dialog id="rules-dialog" aria-labelledby="rules-title"><div class="dialog-top"><span class="eyebrow">THE FIELD MANUAL</span><button class="icon-button" data-action="close-rules" aria-label="Close rules">×</button></div><h2 id="rules-title">How to play Stratego</h2>${guide()}<button class="button primary" data-action="close-rules">Back to the field ${arrow}</button></dialog><dialog id="leave-dialog" aria-labelledby="leave-title"><h2 id="leave-title">Leave this room?</h2><p>Your seat, your army and the saved match will be cleared on this device.</p><div class="dialog-actions"><button class="button secondary" data-action="cancel-leave">Keep playing</button><button class="button primary" data-action="confirm-leave">Leave room</button></div></dialog>`;
}

function render() {
  root.innerHTML = `<div class="app-shell"><header class="site-header"><a class="brand" href="${e(location.pathname)}" data-action="home"><span class="brand-mark" aria-hidden="true">${crest}</span><span>Stratego<span class="brand-caption">HIDE THE FLAG · READ THE ARMY</span></span></a><button class="rules-button" data-action="rules"><span aria-hidden="true">?</span> How to play</button></header><main>${session ? room() : home()}</main><footer><span>Two armies, one field, zero servers.</span><span>Peer-to-peer <i>·</i> Verified reveals <i>·</i> Free forever</span></footer></div>${dialogs()}`;
  if (rulesOpen) document.querySelector<HTMLDialogElement>('#rules-dialog')?.showModal();
  if (leaveOpen) document.querySelector<HTMLDialogElement>('#leave-dialog')?.showModal();
}

function leaveRoom() {
  network?.close();
  session = null; game = null; network = null; resume = null;
  state = 'home'; status = ''; message = ''; fatal = ''; leaveOpen = false; selected = null; lastSent = '';
  try { storage?.removeItem(storageKey); } catch {}
  window.history.replaceState(null, '', location.pathname + location.search); render();
}
function closeDialog(id: string) { document.querySelector<HTMLDialogElement>(id)?.close(); }

/** Board interaction: swap pieces during setup, select and move during play. */
function tapSquare(sq: number) {
  if (!game) return;
  const v = game.view();
  message = '';
  if (v.phase === 'setup' && !v.mySetupDone) {
    const placement = draft(v);
    if (selected === null) { if (placement[sq]) selected = sq; }
    else if (selected === sq) selected = null;
    else if (placement[sq]) { [placement[selected], placement[sq]] = [placement[sq]!, placement[selected]!]; selected = null; persist(); }
    else selected = null;
    render(); return;
  }
  if (v.phase !== 'play' || !v.myTurn) return;
  const piece = v.board[sq];
  if (selected === null || selected === sq) {
    if (piece?.owner === v.color) {
      if (game.legalTargets(sq).length === 0) { selected = null; message = piece.rank === 'B' || piece.rank === 'F' ? `${PIECE_BY_RANK[piece.rank].name}s never move.` : 'That piece has no legal move right now.'; }
      else selected = selected === sq ? null : sq;
    }
    render(); return;
  }
  if (game.legalTargets(selected).includes(sq)) {
    try { game.move(selected, sq); } catch (err) { message = err instanceof GameError ? err.message : 'That move is not allowed.'; }
    selected = null; render(); return;
  }
  selected = piece?.owner === v.color && game.legalTargets(sq).length ? sq : null;
  render();
}

root.addEventListener('input', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'player-name') draftName = target.value;
  if (target.id === 'room-code') draftCode = target.value;
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  if ((event.target as HTMLFormElement).id === 'play-form') await start(joining ? 'guest' : 'host');
});
root.addEventListener('click', async event => {
  const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-square]');
  if (cell?.tagName === 'BUTTON') { tapSquare(Number(cell.dataset.square)); return; }
  if (cell && selected !== null) { selected = null; render(); return; }
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'create-tab') { joining = false; render(); }
  else if (action === 'join-tab') { joining = true; render(); }
  else if (action === 'resume' && resume) await start(resume.role, resume);
  else if (action === 'rules') { if (session) { event.preventDefault(); rulesOpen = true; render(); } }
  else if (action === 'close-rules') { rulesOpen = false; closeDialog('#rules-dialog'); }
  else if (action === 'copy') await copyInvite(false);
  else if (action === 'share') await copyInvite(true);
  else if (action === 'shuffle') { if (session && game) { session.draft = { round: game.view().round, color: game.color, placement: randomSetup(game.color) }; selected = null; persist(); render(); } }
  else if (action === 'ready') {
    if (!game || busy) return;
    busy = true; message = ''; render();
    try { await game.commitSetup(draft(game.view())); selected = null; }
    catch (err) { message = err instanceof Error ? err.message : 'Could not lock your army.'; }
    busy = false; render();
  }
  else if (action === 'resign') { if (confirm('Resign this round? Your opponent wins it.')) { try { game?.resign(); } catch (err) { message = err instanceof Error ? err.message : ''; render(); } } }
  else if (action === 'again') { try { game?.playAgain(); selected = null; } catch (err) { message = err instanceof Error ? err.message : ''; render(); } }
  else if (action === 'leave' || action === 'home') { event.preventDefault(); if (session) { leaveOpen = true; render(); } }
  else if (action === 'cancel-leave') { leaveOpen = false; closeDialog('#leave-dialog'); }
  else if (action === 'confirm-leave') leaveRoom();
});

// Desktop drag-and-drop during setup; taps remain the primary path on touch screens.
let dragging: number | null = null;
root.addEventListener('dragstart', event => {
  const cell = (event.target as HTMLElement).closest<HTMLElement>('button[data-square]');
  if (!cell || !game || game.view().phase !== 'setup') { event.preventDefault(); return; }
  dragging = Number(cell.dataset.square); selected = null;
  event.dataTransfer?.setData('text/plain', String(dragging));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  cell.classList.add('dragging');
});
root.addEventListener('dragover', event => {
  const cell = (event.target as HTMLElement).closest<HTMLElement>('.cell.home');
  if (cell && dragging !== null) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
});
root.addEventListener('drop', event => {
  const cell = (event.target as HTMLElement).closest<HTMLElement>('.cell.home');
  if (!cell || dragging === null || !game) return;
  event.preventDefault();
  const to = Number(cell.dataset.square), placement = draft(game.view());
  if (placement[dragging] && placement[to] && to !== dragging) { [placement[dragging], placement[to]] = [placement[to]!, placement[dragging]!]; persist(); }
  dragging = null; render();
});
root.addEventListener('dragend', () => { dragging = null; document.querySelector('.dragging')?.classList.remove('dragging'); });

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (rulesOpen) { rulesOpen = false; closeDialog('#rules-dialog'); }
  if (leaveOpen) { leaveOpen = false; closeDialog('#leave-dialog'); }
  if (selected !== null) { selected = null; render(); }
});
window.addEventListener('beforeunload', () => persist());
window.addEventListener('pagehide', () => persist());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

render();
// Opening the room's own link (a reload, a killed tab, a phone coming back) rejoins the saved seat straight away.
if (resume && linkRoom && linkRoom === resume.code) void start(resume.role, resume);
