// A small MQTT 3.1.1 client over WebSocket: connect, publish (QoS 0/1, retain),
// subscribe, keep-alive and a will message. Just enough for the relay
// transport, with the packet codec exported so it can be tested on its own.
const encoder = new TextEncoder(), decoder = new TextDecoder();

export const PacketType = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 } as const;

const utf8 = (text: string) => { const bytes = encoder.encode(text); return [bytes.length >> 8, bytes.length & 255, ...bytes]; };
const remainingLength = (length: number) => { const out: number[] = []; do { let digit = length % 128; length = Math.floor(length / 128); if (length > 0) digit |= 128; out.push(digit); } while (length > 0); return out; };
export const packet = (type: number, flags: number, body: ArrayLike<number>) => new Uint8Array([(type << 4) | flags, ...remainingLength(body.length), ...Array.from(body)]);

export interface WillMessage { topic: string; payload: Uint8Array; retain?: boolean }
export function encodeConnect(clientId: string, keepAlive: number, will?: WillMessage) {
  let flags = 0x02;                                    // clean session
  const payload: number[] = [...utf8(clientId)];
  if (will) { flags |= 0x04 | (will.retain ? 0x20 : 0); payload.push(...utf8(will.topic), will.payload.length >> 8, will.payload.length & 255, ...will.payload); }
  return packet(PacketType.CONNECT, 0, [...utf8('MQTT'), 4, flags, keepAlive >> 8, keepAlive & 255, ...payload]);
}
export function encodePublish(topic: string, payload: Uint8Array, options: { retain?: boolean; qos?: 0 | 1; packetId?: number } = {}) {
  const qos = options.qos ?? 0;
  const head = [...utf8(topic), ...(qos ? [options.packetId! >> 8, options.packetId! & 255] : [])];
  return packet(PacketType.PUBLISH, (qos << 1) | (options.retain ? 1 : 0), [...head, ...payload]);
}
export const encodeSubscribe = (packetId: number, topics: string[], qos: 0 | 1 = 1) => packet(PacketType.SUBSCRIBE, 2, [packetId >> 8, packetId & 255, ...topics.flatMap(t => [...utf8(t), qos])]);
export const encodePuback = (packetId: number) => packet(PacketType.PUBACK, 0, [packetId >> 8, packetId & 255]);
export const PINGREQ = packet(PacketType.PINGREQ, 0, []);
export const DISCONNECT = packet(PacketType.DISCONNECT, 0, []);

export type Decoded =
  | { type: 2; sessionPresent: boolean; returnCode: number }
  | { type: 3; topic: string; payload: Uint8Array; retain: boolean; qos: number; packetId?: number }
  | { type: 4 | 9 | 11; packetId: number }
  | { type: 13 }
  | { type: number };

/** Parses every complete packet at the front of `buffer`; returns them and the unread remainder. */
export function decode(buffer: Uint8Array): { packets: Decoded[]; rest: Uint8Array } {
  const packets: Decoded[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const first = buffer[offset]!;
    let length = 0, multiplier = 1, i = offset + 1;
    let digit: number;
    do {
      if (i >= buffer.length) return { packets, rest: buffer.slice(offset) };
      digit = buffer[i++]!; length += (digit & 127) * multiplier; multiplier *= 128;
      if (multiplier > 128 ** 4) throw new Error('Malformed remaining length');
    } while (digit & 128);
    if (i + length > buffer.length) return { packets, rest: buffer.slice(offset) };
    const body = buffer.subarray(i, i + length), type = first >> 4, flags = first & 15;
    if (type === PacketType.CONNACK) packets.push({ type, sessionPresent: !!(body[0]! & 1), returnCode: body[1]! });
    else if (type === PacketType.PUBLISH) {
      const topicLength = (body[0]! << 8) | body[1]!, qos = (flags >> 1) & 3;
      let at = 2 + topicLength;
      const topic = decoder.decode(body.subarray(2, at));
      let packetId: number | undefined;
      if (qos) { packetId = (body[at]! << 8) | body[at + 1]!; at += 2; }
      packets.push({ type, topic, payload: body.slice(at), retain: !!(flags & 1), qos, packetId });
    } else if (type === PacketType.PUBACK || type === PacketType.SUBACK || type === PacketType.UNSUBACK) packets.push({ type, packetId: (body[0]! << 8) | body[1]! });
    else packets.push({ type });
    offset = i + length;
  }
  return { packets, rest: new Uint8Array(0) };
}

export interface MqttMessage { topic: string; payload: Uint8Array; retain: boolean }
export interface MqttHandlers { onConnect(): void; onMessage(message: MqttMessage): void; onClose(reason: string): void }
export interface MqttOptions { url: string; clientId: string; keepAlive?: number; will?: WillMessage; connectTimeoutMs?: number }

export class MqttClient {
  private ws: WebSocket | null = null;
  private buffer: Uint8Array = new Uint8Array(0);
  private nextId = 1;
  private waiting = new Map<number, () => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDue = 0;
  private closed = false;
  connected = false;
  private options: MqttOptions;
  private handlers: MqttHandlers;
  constructor(options: MqttOptions, handlers: MqttHandlers) { this.options = options; this.handlers = handlers; }
  get url() { return this.options.url; }

  connect() {
    const keepAlive = this.options.keepAlive ?? 30;
    let ws: WebSocket;
    try { ws = new WebSocket(this.options.url, 'mqtt'); } catch (error) { this.finish(`open failed: ${String(error)}`); return; }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    const connectTimer = setTimeout(() => { if (!this.connected) this.finish('connect timeout'); }, this.options.connectTimeoutMs ?? 10000);
    ws.onopen = () => ws.send(encodeConnect(this.options.clientId, keepAlive, this.options.will));
    ws.onmessage = event => {
      const chunk = new Uint8Array(event.data as ArrayBuffer);
      const merged = new Uint8Array(this.buffer.length + chunk.length); merged.set(this.buffer); merged.set(chunk, this.buffer.length);
      let parsed: ReturnType<typeof decode>;
      try { parsed = decode(merged); } catch { this.finish('malformed packet'); return; }
      this.buffer = parsed.rest;
      for (const p of parsed.packets) {
        if (p.type === PacketType.CONNACK) {
          const ack = p as Extract<Decoded, { type: 2 }>;
          if (ack.returnCode !== 0) { this.finish(`refused (${ack.returnCode})`); return; }
          clearTimeout(connectTimer); this.connected = true; this.pongDue = 0;
          this.pingTimer = setInterval(() => {
            if (this.pongDue && Date.now() > this.pongDue) { this.finish('keep-alive timeout'); return; }
            if (!this.pongDue) this.pongDue = Date.now() + keepAlive * 1000;
            try { ws.send(PINGREQ); } catch { this.finish('send failed'); }
          }, Math.max(5, keepAlive / 2) * 1000);
          this.handlers.onConnect();
        } else if (p.type === PacketType.PINGRESP) this.pongDue = 0;
        else if (p.type === PacketType.PUBLISH) {
          const m = p as Extract<Decoded, { type: 3 }>;
          if (m.qos === 1 && m.packetId !== undefined) { try { ws.send(encodePuback(m.packetId)); } catch {} }
          this.handlers.onMessage({ topic: m.topic, payload: m.payload, retain: m.retain });
        } else if ('packetId' in p && typeof p.packetId === 'number') {
          this.waiting.get(p.packetId)?.(); this.waiting.delete(p.packetId);
        }
      }
    };
    ws.onerror = () => this.finish('socket error');
    ws.onclose = event => this.finish(`closed (${event.code})`);
  }
  private id() { const id = this.nextId; this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1; return id; }
  private acked(id: number, timeoutMs = 10000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('no acknowledgement')); }, timeoutMs);
      this.waiting.set(id, () => { clearTimeout(timer); resolve(); });
    });
  }
  publish(topic: string, payload: Uint8Array, options: { retain?: boolean; qos?: 0 | 1 } = {}) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('not connected'));
    const qos = options.qos ?? 1, packetId = qos ? this.id() : undefined;
    const done = qos ? this.acked(packetId!) : Promise.resolve();
    try { this.ws.send(encodePublish(topic, payload, { retain: options.retain, qos, packetId })); } catch (error) { return Promise.reject(error); }
    return done;
  }
  subscribe(topics: string[]) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('not connected'));
    const packetId = this.id(), done = this.acked(packetId);
    try { this.ws.send(encodeSubscribe(packetId, topics)); } catch (error) { return Promise.reject(error); }
    return done;
  }
  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const resolve of this.waiting.values()) resolve();
    this.waiting.clear();
    try { this.ws?.close(); } catch {}
    this.handlers.onClose(reason);
  }
  close() {
    if (this.connected) { try { this.ws?.send(DISCONNECT); } catch {} }
    this.finish('closed by client');
  }
}
