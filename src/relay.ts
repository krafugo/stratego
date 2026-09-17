// Store-and-forward relay over public MQTT brokers. Both seats publish their
// latest transcript as a retained message on `stratego/v1/<code>/<role>` and
// subscribe to the other seat, so a move is delivered even when the opponent
// is offline for hours. Everything is sealed with AES-GCM under a key derived
// from the room code: the brokers, and anyone browsing them, see ciphertext.
// Every configured broker is used at once; a message only needs to get
// through on one of them, and transcripts merge idempotently on arrival.
import { MqttClient } from './mqtt.ts';
import type { Round } from './game.ts';
import { randomHex } from './crypto.ts';

export type Role = 'host' | 'guest';
export interface PeerHello { token: string; name: string; role: Role; seat: string | null; online: boolean; left: boolean; at: number; session: string }
export interface RelayState { connected: number; total: number; peerOnline: boolean; peerSeenAt: number }
export interface RelayHandlers {
  hello(peer: PeerHello): void;
  sync(rounds: unknown, token: string): void;
  state(state: RelayState): void;
}
type Envelope =
  | { type: 'hello'; token: string; name: string; role: Role; seat: string | null; online: boolean; left?: boolean; at: number; session: string }
  | { type: 'sync'; token: string; rounds: Round[]; at: number };

const encoder = new TextEncoder(), decoder = new TextDecoder();
export const PRESENCE_TTL = 45000;
export const HEARTBEAT = 20000;

export async function roomKey(code: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`stratego-relay-v1:${code}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + cipher.length); out.set(iv); out.set(cipher, iv.length);
  return out;
}
export async function open(key: CryptoKey, bytes: Uint8Array): Promise<unknown | null> {
  if (bytes.length < 13) return null;
  try { return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)))); }
  catch { return null; }
}
export const peerIsOnline = (hello: PeerHello | null, now = Date.now()) => !!hello && hello.online && !hello.left && now - hello.at < PRESENCE_TTL;

interface Seat { code: string; role: Role; token: string; name: string; remoteToken: string | null }

export class RelayTransport {
  private seat: Seat;
  private brokers: string[];
  private handlers: RelayHandlers;
  private key: CryptoKey | null = null;
  private clients = new Map<string, { client: MqttClient | null; attempts: number; timer: ReturnType<typeof setTimeout> | null }>();
  private session = randomHex(4);
  private rounds: Round[] | null = null;
  private peer: PeerHello | null = null;
  private lastSyncAt = 0;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval>;
  private presence: ReturnType<typeof setInterval>;
  private lastState = '';
  constructor(seat: Seat, brokers: string[], handlers: RelayHandlers) {
    this.seat = seat; this.brokers = brokers; this.handlers = handlers;
    this.heartbeat = setInterval(() => void this.publishHello(true), HEARTBEAT);
    this.presence = setInterval(() => this.emitState(), 5000);
    void this.start();
  }
  private get base() { return `stratego/v1/${this.seat.code}`; }
  /** One topic per message kind: a broker retains a single message per topic. */
  private mine(kind: 'hello' | 'sync') { return `${this.base}/${this.seat.role}/${kind}`; }
  private theirs(kind: 'hello' | 'sync') { return `${this.base}/${this.seat.role === 'host' ? 'guest' : 'host'}/${kind}`; }
  get state(): RelayState {
    return { connected: [...this.clients.values()].filter(c => c.client?.connected).length, total: this.brokers.length, peerOnline: peerIsOnline(this.peer), peerSeenAt: this.peer?.at ?? 0 };
  }
  private emitState() {
    if (this.closed) return;
    const text = JSON.stringify(this.state);
    if (text !== this.lastState) { this.lastState = text; this.handlers.state(this.state); }
  }
  private hello(online: boolean, left = false): Envelope {
    return { type: 'hello', token: this.seat.token, name: this.seat.name, role: this.seat.role, seat: this.seat.remoteToken, online, left, at: Date.now(), session: this.session };
  }
  private async start() {
    this.key = await roomKey(this.seat.code);
    for (const url of this.brokers) { this.clients.set(url, { client: null, attempts: 0, timer: null }); void this.connect(url); }
  }
  private async connect(url: string) {
    const slot = this.clients.get(url);
    if (!slot || this.closed || !this.key) return;
    const will = await seal(this.key, this.hello(false));
    const client = new MqttClient({ url, clientId: `st-${this.seat.token.slice(0, 8)}-${randomHex(3)}`, keepAlive: 30, will: { topic: this.mine('hello'), payload: will, retain: true } }, {
      onConnect: async () => {
        slot.attempts = 0;
        try {
          await client.subscribe([this.theirs('hello'), this.theirs('sync')]);
          await this.publishTo(client, this.hello(true));
          if (this.rounds) await this.publishTo(client, { type: 'sync', token: this.seat.token, rounds: this.rounds, at: Date.now() });
        } catch {}
        this.emitState();
      },
      onMessage: message => void this.receive(message.topic, message.payload),
      onClose: () => {
        if (slot.client === client) slot.client = null;
        this.emitState();
        if (this.closed) return;
        const delay = Math.min(30000, 2000 * 2 ** Math.min(slot.attempts++, 4));
        slot.timer = setTimeout(() => void this.connect(url), delay);
      },
    });
    slot.client = client;
    client.connect();
  }
  private async receive(topic: string, payload: Uint8Array) {
    const kind = topic === this.theirs('hello') ? 'hello' : topic === this.theirs('sync') ? 'sync' : null;
    if (!kind || !payload.length || !this.key) return;
    const env = await open(this.key, payload) as Envelope | null;
    if (!env || typeof env !== 'object' || env.type !== kind || typeof env.token !== 'string' || typeof env.at !== 'number') return;
    if (env.type === 'hello') {
      if (typeof env.name !== 'string' || (env.role !== 'host' && env.role !== 'guest')) return;
      const hello: PeerHello = { token: env.token, name: env.name.slice(0, 20), role: env.role, seat: env.seat ?? null, online: !!env.online, left: !!env.left, at: env.at, session: String(env.session ?? '') };
      // A will (online:false) for the session we last saw wins even with an older timestamp; otherwise newest wins.
      const current = this.peer;
      if (!current || hello.at >= current.at || (!hello.online && hello.session === current.session)) { this.peer = hello; this.handlers.hello(hello); }
      this.emitState();
    } else if (env.type === 'sync' && Array.isArray(env.rounds)) {
      if (env.at <= this.lastSyncAt) return;      // the same snapshot arriving from another broker
      this.lastSyncAt = env.at;
      this.handlers.sync(env.rounds, env.token);
    }
  }
  private async publishTo(client: MqttClient, env: Envelope, clear = false) {
    if (!this.key || !client.connected) return;
    await client.publish(this.mine(env.type), clear ? new Uint8Array(0) : await seal(this.key, env), { retain: true, qos: 1 });
  }
  private async publishAll(env: Envelope, clear = false) {
    await Promise.all([...this.clients.values()].map(slot => slot.client ? this.publishTo(slot.client, env, clear).catch(() => {}) : Promise.resolve()));
  }
  private async publishHello(online: boolean, left = false) { if (!this.closed) await this.publishAll(this.hello(online, left)); }
  /** Republishes the seat announcement after the opponent's token is pinned. */
  announce() { void this.publishHello(true); }
  send(rounds: Round[]) {
    this.rounds = rounds;
    void this.publishAll({ type: 'sync', token: this.seat.token, rounds, at: Date.now() });
  }
  /** Tell the other seat we are gone for good and clear our retained transcript, then disconnect. */
  async leave() {
    if (this.closed) return;
    const farewell = Promise.all([this.publishAll(this.hello(false, true)), this.publishAll({ type: 'sync', token: this.seat.token, rounds: [], at: Date.now() }, true)]);
    try { await Promise.race([farewell, new Promise(r => setTimeout(r, 1500))]); } catch {}
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat); clearInterval(this.presence);
    for (const slot of this.clients.values()) { if (slot.timer) clearTimeout(slot.timer); slot.client?.close(); slot.client = null; }
  }
}
