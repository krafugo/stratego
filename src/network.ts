// A room runs two transports at once and the game does not care which one
// delivers a move:
//   · direct — a WebRTC data channel between the two browsers (PeerJS for
//     signalling, STUN/TURN from the ICE pool); fastest, fully peer-to-peer.
//   · relay  — encrypted retained messages on public MQTT brokers; survives
//     symmetric NATs, VPNs and one player being offline for hours.
// Both peers merge every transcript they receive, so duplicates are harmless
// and whichever path is up first carries the game. GitHub Pages only serves
// the static site.
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Round, Saved } from './game.ts';
import { randomHex } from './crypto.ts';
import { RelayTransport, peerIsOnline, type PeerHello, type RelayState } from './relay.ts';

export type Role = 'host' | 'guest';
export type StatusKind = 'connecting' | 'waiting' | 'connected' | 'offline' | 'rejected' | 'left';
export type Path = 'direct' | 'relay' | 'none';
export interface Session {
  version: 1; role: Role; name: string; code: string; token: string;
  remoteToken: string | null; remoteName: string | null;
  game?: Saved;
}
export interface Callbacks {
  status(kind: StatusKind, text: string, path: Path): void;
  ready(remote: { name: string; token: string }): void;
  data(rounds: unknown): void;
  error(text: string): void;
}
export interface RoomOptions { peer: PeerOptions | null; brokers: string[] }
type Message =
  | { type: 'hello'; version: 1; code: string; role: Role; token: string; name: string }
  | { type: 'reject'; reason: string }
  | { type: 'sync'; rounds: Round[] }
  | { type: 'ping' } | { type: 'pong' } | { type: 'leave' };

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map(n => alphabet[n % alphabet.length]).join('');
export const normalizeCode = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
export const validCode = (value: string) => /^[A-HJ-NP-Z2-9]{8}$/.test(value);
export const createSession = (role: Role, name: string, code = makeCode()): Session => ({
  version: 1, role, name: name.trim().slice(0, 20) || 'Player', code, token: randomHex(), remoteToken: null, remoteName: null,
});
export const RESERVED = 'This seat belongs to the player who joined first. To rejoin a game, open the room link on the device and browser you played from.';

const PREFIX = 'stratego1';
type DirectKind = 'connecting' | 'waiting' | 'connected' | 'offline';
interface DirectHandlers {
  /** Seat check: true when this token may take (or already holds) the other seat. */
  admit(token: string, name: string): boolean;
  ready(remote: { name: string; token: string }): void;
  data(rounds: unknown): void;
  rejected(reason: string): void;
  left(): void;
  state(kind: DirectKind, text: string): void;
  error(text: string): void;
}

/** WebRTC data channel via the public PeerServer. Retries forever; the room decides what its state means. */
class DirectTransport {
  private peer!: Peer;
  private conn: DataConnection | null = null;
  private closed = false;
  private stopped = false;
  private lastSeen = 0;
  private interval: ReturnType<typeof setInterval>;
  private wake = () => { if (document.visibilityState !== 'hidden') this.probe(); };
  connected = false;
  kind: DirectKind = 'connecting';
  private session: Session;
  private handlers: DirectHandlers;
  private options: PeerOptions;
  constructor(session: Session, handlers: DirectHandlers, options: PeerOptions) {
    this.session = session; this.handlers = handlers; this.options = options;
    this.start();
    this.interval = setInterval(() => this.tick(), 5000);
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }
  private state(kind: DirectKind, text: string) { this.kind = kind; this.handlers.state(kind, text); }
  private start() {
    if (this.closed) return;
    this.state('connecting', this.session.role === 'host' ? 'Opening your war room…' : 'Finding your opponent…');
    const id = this.session.role === 'host' ? `${PREFIX}-${this.session.code}` : `${PREFIX}-player-${this.session.token}`;
    const peer = new Peer(id, this.options);
    this.peer = peer;
    peer.on('open', () => {
      if (this.closed || this.peer !== peer) return;
      this.state('waiting', this.session.role === 'host' ? 'Room open · invite your opponent' : 'Connecting to your opponent…');
      if (this.session.role === 'guest') this.dial();
    });
    peer.on('connection', conn => {
      if (this.session.role !== 'host') { conn.on('open', () => conn.close()); return; }
      this.attach(conn);
    });
    peer.on('error', error => {
      if (this.closed || this.peer !== peer || this.connected) return;
      const text = error.type === 'peer-unavailable' ? 'Room not found yet. Check the code and ask your friend to keep their room open.'
        : error.type === 'unavailable-id' ? 'This room is already open in another tab, or still reconnecting. Close the extra tab and retry.'
        : 'No direct route yet. Trying again…';
      this.state('offline', text);
    });
    peer.on('disconnected', () => { if (!this.connected && !this.closed) this.state('offline', 'Signalling interrupted. Retrying…'); });
  }
  private dial() {
    if (this.closed || this.stopped || this.conn || this.peer.disconnected || this.peer.destroyed) return;
    this.attach(this.peer.connect(`${PREFIX}-${this.session.code}`, { reliable: true, serialization: 'json', metadata: { version: 1, code: this.session.code, token: this.session.token } }));
  }
  private attach(conn: DataConnection) {
    let accepted = false;
    const meta = (conn.metadata ?? {}) as Partial<{ version: number; code: string; token: string }>;
    const timeout = setTimeout(() => {
      if (accepted) return;
      conn.close();
      if (this.conn === conn) this.conn = null;
      if (!this.connected) this.state('offline', 'No direct route yet. Trying again…');
    }, 20000);
    const reject = (reason: string) => { try { conn.send({ type: 'reject', reason } satisfies Message); } catch {} setTimeout(() => conn.close(), 150); };
    conn.on('open', () => {
      if (this.closed) { conn.close(); return; }
      if (this.session.role === 'host' && (meta.code !== this.session.code || meta.version !== 1 || typeof meta.token !== 'string' || !this.handlers.admit(meta.token, ''))) { reject(RESERVED); return; }
      conn.send({ type: 'hello', version: 1, code: this.session.code, role: this.session.role, token: this.session.token, name: this.session.name } satisfies Message);
    });
    conn.on('data', raw => {
      if (this.closed || !raw || typeof raw !== 'object') return;
      const message = raw as Message;
      if (message.type === 'reject' && !accepted && this.session.role === 'guest' && this.conn === conn) {
        clearTimeout(timeout); this.stopped = true; this.handlers.rejected(String(message.reason).slice(0, 200)); conn.close(); return;
      }
      if (message.type === 'hello') {
        if (accepted) return;
        const expectedRole = this.session.role === 'host' ? 'guest' : 'host';
        const valid = message.version === 1 && message.code === this.session.code && message.role === expectedRole && /^[a-f0-9]{32}$/.test(message.token) && typeof message.name === 'string'
          && !(this.session.role === 'host' && message.token !== meta.token) && this.handlers.admit(message.token, message.name.slice(0, 20));
        if (!valid) { reject(RESERVED); return; }
        accepted = true; clearTimeout(timeout);
        const old = this.conn;
        this.conn = conn; this.connected = true; this.lastSeen = Date.now();
        if (old && old !== conn) old.close();
        this.state('connected', 'Connected · direct link');
        this.handlers.ready({ name: message.name.slice(0, 20), token: message.token });
        return;
      }
      if (!accepted || this.conn !== conn) return;
      this.lastSeen = Date.now();
      if (message.type === 'ping') conn.send({ type: 'pong' } satisfies Message);
      if (message.type === 'sync' && Array.isArray(message.rounds)) {
        if (JSON.stringify(message).length > 1500000) { this.handlers.error('This room exceeded its data limit. Please start a new room.'); return; }
        this.handlers.data(message.rounds);
      }
      if (message.type === 'leave') { this.stopped = true; conn.close(); this.handlers.left(); }
    });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (this.conn !== conn || this.closed) return;
      this.conn = null; this.connected = false;
      if (!this.stopped) this.state('offline', 'Direct link dropped. Reconnecting…');
    });
    conn.on('error', () => { clearTimeout(timeout); conn.close(); });
    // Reserve the outbound attempt so repeated timer ticks cannot race it.
    if (this.session.role === 'guest' && !this.conn) this.conn = conn;
  }
  send(rounds: Round[]) { if (this.connected && this.conn?.open) this.conn.send({ type: 'sync', rounds } satisfies Message); }
  private tick() {
    if (this.closed || this.stopped) return;
    if (this.connected) {
      if (Date.now() - this.lastSeen > 25000) { this.conn?.close(); return; }
      this.conn?.send({ type: 'ping' } satisfies Message); return;
    }
    this.retry();
  }
  /** Coming back online or to the foreground: a channel that died while the tab slept gets 4 s to answer a ping, then we reconnect. */
  private probe() {
    if (this.closed || this.stopped) return;
    if (!this.connected) { this.retry(); return; }
    const seen = this.lastSeen;
    try { this.conn?.send({ type: 'ping' } satisfies Message); } catch { this.conn?.close(); return; }
    setTimeout(() => { if (!this.closed && this.connected && this.lastSeen === seen) this.conn?.close(); }, 4000);
  }
  private retry() {
    if (this.closed || this.stopped || this.connected) return;
    if (this.peer.destroyed) this.start();
    else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
    else if (this.session.role === 'guest') this.dial();
  }
  close(sayGoodbye: boolean) {
    try { if (sayGoodbye && this.connected) this.conn?.send({ type: 'leave' } satisfies Message); } catch {}
    this.closed = true; clearInterval(this.interval); this.peer?.destroy();
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
  }
}

export class Room {
  private session: Session;
  private callbacks: Callbacks;
  private direct: DirectTransport | null = null;
  private relay: RelayTransport | null = null;
  private directText = 'Opening a connection…';
  private relayState: RelayState = { connected: 0, total: 0, peerOnline: false, peerSeenAt: 0 };
  private relayPeer: PeerHello | null = null;
  private relayWasOnline = false;
  private rejected: string | null = null;
  private left = false;
  private closed = false;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(session: Session, callbacks: Callbacks, options: RoomOptions) {
    this.session = session; this.callbacks = callbacks;
    if (options.peer) {
      this.direct = new DirectTransport(session, {
        admit: (token, name) => this.admit(token, name),
        ready: remote => this.callbacks.ready(remote),
        data: rounds => this.callbacks.data(rounds),
        rejected: reason => { this.rejected = reason; this.refresh(); },
        left: () => { this.left = true; this.refresh(); },
        state: (_kind, text) => { this.directText = text; this.refresh(); },
        error: text => this.callbacks.error(text),
      }, options.peer);
    }
    if (options.brokers.length) {
      this.relay = new RelayTransport(session, options.brokers, {
        hello: peer => this.onRelayHello(peer),
        sync: (rounds, token) => { if (token === this.session.remoteToken) this.callbacks.data(rounds); },
        state: state => { this.relayState = state; this.refreshPresence(); this.refresh(); },
      });
    }
    this.refresh();
  }
  get path(): Path { return this.direct?.connected ? 'direct' : this.relayState.peerOnline ? 'relay' : 'none'; }
  /** Seat pinning: the first token to arrive holds the other seat for the life of the room. */
  private admit(token: string, name: string) {
    if (this.session.remoteToken && this.session.remoteToken !== token) return false;
    if (!this.session.remoteToken) { this.session.remoteToken = token; this.relay?.announce(); }
    if (name) this.session.remoteName = name;
    return true;
  }
  private onRelayHello(peer: PeerHello) {
    if (this.closed) return;
    if (peer.seat && peer.seat !== this.session.token) { this.rejected = RESERVED; this.relay?.close(); this.direct?.close(false); this.refresh(); return; }
    if (peer.left) { if (peer.token === this.session.remoteToken) this.left = true; this.refresh(); return; }
    if (!this.admit(peer.token, peer.name)) return;
    this.relayPeer = peer;
    this.refreshPresence();
    this.refresh();
  }
  private refreshPresence() {
    const online = peerIsOnline(this.relayPeer);
    this.relayState = { ...this.relayState, peerOnline: online, peerSeenAt: this.relayPeer?.at ?? 0 };
    if (online && !this.relayWasOnline && this.relayPeer) this.callbacks.ready({ name: this.relayPeer.name, token: this.relayPeer.token });
    this.relayWasOnline = online;
  }
  private refresh() {
    if (this.closed) return;
    const seated = !!this.session.remoteToken, friend = this.session.remoteName ?? 'your opponent';
    if (this.rejected) return this.callbacks.status('rejected', this.rejected, 'none');
    if (this.left) return this.callbacks.status('left', 'Your opponent left the room. Create a new room to play again.', 'none');
    if (this.direct?.connected) return this.callbacks.status('connected', 'Connected · direct link', 'direct');
    if (this.relayState.peerOnline) return this.callbacks.status('connected', `Connected · relay${this.relay ? ` (${this.relayState.connected}/${this.relayState.total})` : ''}`, 'relay');
    if (seated && this.relayState.connected > 0) return this.callbacks.status('waiting', `${friend} is away · your moves are stored and delivered the moment they return`, 'relay');
    if (!seated && (this.relayState.connected > 0 || this.direct?.kind === 'waiting')) {
      return this.callbacks.status('waiting', this.session.role === 'host' ? 'Room open · invite your opponent' : 'Finding your opponent…', this.relayState.connected > 0 ? 'relay' : 'none');
    }
    if (this.direct?.kind === 'connecting' || (this.relay && this.relayState.connected === 0 && !seated)) return this.callbacks.status('connecting', this.directText, 'none');
    return this.callbacks.status('offline', seated ? 'Connection lost. The board is saved on both sides; it resumes as soon as a path is back.' : this.directText, 'none');
  }
  send(rounds: Round[]) {
    this.direct?.send(rounds);
    if (!this.relay) return;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => { this.sendTimer = null; this.relay?.send(rounds); }, 300);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.direct?.close(true);
    void this.relay?.leave();
  }
}
