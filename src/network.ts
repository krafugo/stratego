// Room discovery and signalling go through the public PeerServer; every game
// message travels over a reliable, encrypted WebRTC data channel between the
// two browsers. GitHub Pages only serves the static site.
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Round } from './game.ts';
import { randomHex } from './crypto.ts';

export type Role = 'host' | 'guest';
export type StatusKind = 'connecting' | 'waiting' | 'connected' | 'offline' | 'rejected' | 'left';
export interface Session {
  version: 1; role: Role; name: string; code: string; token: string;
  remoteToken: string | null; remoteName: string | null;
  game?: import('./game.ts').Saved;
}
export interface Callbacks {
  status(kind: StatusKind, text: string): void;
  ready(remote: { name: string; token: string }): void;
  data(rounds: unknown): void;
  error(text: string): void;
}
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

export async function connectionOptions(): Promise<PeerOptions> {
  const settings = window.STRATEGO_CONNECTION ?? {};
  let iceServers = settings.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
  if (settings.turnCredentialEndpoint) {
    const response = await fetch(settings.turnCredentialEndpoint, { signal: AbortSignal.timeout(10000), credentials: 'omit' });
    if (!response.ok) throw new Error('The connection relay is unavailable. Please try again.');
    const data = await response.json() as { iceServers?: RTCIceServer[] };
    if (!Array.isArray(data.iceServers)) throw new Error('The connection relay returned invalid settings.');
    iceServers = [...iceServers, ...data.iceServers];
  }
  return { ...settings.peerServer, debug: 0, config: { iceServers, ...(settings.iceTransportPolicy ? { iceTransportPolicy: settings.iceTransportPolicy } : {}) } };
}

const PREFIX = 'stratego1';

export class RoomConnection {
  private peer!: Peer;
  private conn: DataConnection | null = null;
  private closed = false;
  private rejected = false;
  private connected = false;
  private lastSeen = 0;
  private interval: ReturnType<typeof setInterval>;
  private wake = () => this.tick();
  private session: Session;
  private callbacks: Callbacks;
  private options: PeerOptions;
  constructor(session: Session, callbacks: Callbacks, options: PeerOptions) {
    this.session = session; this.callbacks = callbacks; this.options = options;
    this.start();
    this.interval = setInterval(() => this.tick(), 5000);
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }
  get isConnected() { return this.connected; }
  private status(kind: StatusKind, text: string) { this.callbacks.status(kind, text); }
  private start() {
    if (this.closed) return;
    this.status('connecting', this.session.role === 'host' ? 'Opening your war room…' : 'Finding your opponent…');
    const id = this.session.role === 'host' ? `${PREFIX}-${this.session.code}` : `${PREFIX}-player-${this.session.token}`;
    const peer = new Peer(id, this.options);
    this.peer = peer;
    peer.on('open', () => {
      if (this.closed || this.peer !== peer) return;
      this.status('waiting', this.session.role === 'host' ? 'Room open · invite your opponent' : 'Connecting to your opponent…');
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
        : 'Couldn’t connect. Check your internet or try another network. Some networks need a relay.';
      this.status('offline', text);
    });
    peer.on('disconnected', () => { if (!this.connected && !this.closed) this.status('offline', 'Connection interrupted. Your game is saved in this tab. Retrying…'); });
  }
  private dial() {
    if (this.closed || this.conn || this.peer.disconnected || this.peer.destroyed) return;
    this.attach(this.peer.connect(`${PREFIX}-${this.session.code}`, { reliable: true, serialization: 'json', metadata: { version: 1, code: this.session.code, token: this.session.token } }));
  }
  private attach(conn: DataConnection) {
    let accepted = false;
    const meta = (conn.metadata ?? {}) as Partial<{ version: number; code: string; token: string }>;
    const timeout = setTimeout(() => {
      if (accepted) return;
      conn.close();
      if (this.conn === conn) this.conn = null;
      if (!this.connected) this.status('offline', 'Your opponent hasn’t connected yet. Keep both screens open, check the code, or try another network.');
    }, 20000);
    const reject = (reason: string) => { try { conn.send({ type: 'reject', reason } satisfies Message); } catch {} setTimeout(() => conn.close(), 150); };
    conn.on('open', () => {
      if (this.closed) { conn.close(); return; }
      if (this.connected && this.conn !== conn && meta.token !== this.session.remoteToken) { reject('This room already has two players.'); return; }
      if (this.session.role === 'host' && (meta.code !== this.session.code || meta.version !== 1 || (this.session.remoteToken && meta.token !== this.session.remoteToken))) {
        reject('This room is reserved for the original two players.'); return;
      }
      conn.send({ type: 'hello', version: 1, code: this.session.code, role: this.session.role, token: this.session.token, name: this.session.name } satisfies Message);
    });
    conn.on('data', raw => {
      if (this.closed || !raw || typeof raw !== 'object') return;
      const message = raw as Message;
      if (message.type === 'reject' && !accepted && this.session.role === 'guest' && this.conn === conn) {
        clearTimeout(timeout); this.rejected = true; this.status('rejected', String(message.reason).slice(0, 150)); conn.close(); return;
      }
      if (message.type === 'hello') {
        if (accepted) return;
        const expectedRole = this.session.role === 'host' ? 'guest' : 'host';
        const valid = message.version === 1 && message.code === this.session.code && message.role === expectedRole && /^[a-f0-9]{32}$/.test(message.token) && typeof message.name === 'string'
          && !(this.session.role === 'host' && message.token !== meta.token) && !(this.session.remoteToken && this.session.remoteToken !== message.token) && !(this.connected && this.conn !== conn && message.token !== this.session.remoteToken);
        if (!valid) { reject('This room is reserved for the original two players.'); return; }
        accepted = true; clearTimeout(timeout);
        const old = this.conn;
        this.conn = conn; this.connected = true; this.lastSeen = Date.now();
        if (old && old !== conn) old.close();
        this.session.remoteToken = message.token; this.session.remoteName = message.name.slice(0, 20);
        this.status('connected', 'Both players connected');
        this.callbacks.ready({ name: this.session.remoteName, token: message.token });
        return;
      }
      if (!accepted || this.conn !== conn) return;
      this.lastSeen = Date.now();
      if (message.type === 'ping') conn.send({ type: 'pong' } satisfies Message);
      if (message.type === 'sync' && Array.isArray(message.rounds)) {
        if (JSON.stringify(message).length > 1500000) { this.callbacks.error('This room exceeded its data limit. Please start a new room.'); return; }
        this.callbacks.data(message.rounds);
      }
      if (message.type === 'leave') { this.status('left', 'Your opponent left the room. Create a new room to play again.'); this.rejected = true; conn.close(); }
    });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (this.conn !== conn || this.closed) return;
      this.conn = null; this.connected = false;
      if (!this.rejected) this.status('offline', 'Your opponent is reconnecting. The board is saved. Keep this tab open.');
    });
    conn.on('error', () => { clearTimeout(timeout); conn.close(); });
    // Reserve the outbound attempt so repeated timer ticks cannot race it.
    if (this.session.role === 'guest' && !this.conn) this.conn = conn;
  }
  send(rounds: Round[]) { if (this.connected && this.conn?.open) this.conn.send({ type: 'sync', rounds } satisfies Message); }
  private tick() {
    if (this.closed || this.rejected) return;
    if (this.connected) {
      if (Date.now() - this.lastSeen > 25000) { this.conn?.close(); return; }
      this.conn?.send({ type: 'ping' } satisfies Message); return;
    }
    this.retry();
  }
  private retry() {
    if (this.closed || this.rejected || this.connected) return;
    if (this.peer.destroyed) this.start();
    else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
    else if (this.session.role === 'guest') this.dial();
  }
  close() {
    try { if (this.connected) this.conn?.send({ type: 'leave' } satisfies Message); } catch {}
    this.closed = true; clearInterval(this.interval); this.peer?.destroy();
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
  }
}
