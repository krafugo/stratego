// ICE server pool: several free STUN servers plus whatever TURN relays are
// configured. TURN entries are probed before use and only the ones that
// actually hand out relay candidates are passed to WebRTC, so a dead relay
// never slows a connection down and a working one is always preferred.
export interface ConnectionSettings {
  /** STUN (and, if you like, static TURN) servers handed to WebRTC as-is. */
  iceServers?: RTCIceServer[];
  /** TURN relays with static credentials, e.g. a Metered or ExpressTURN free account. Probed before use. */
  turnServers?: RTCIceServer[];
  /** URLs that mint short-lived TURN credentials and answer `{ iceServers: [...] }`. */
  turnCredentialEndpoints?: string[];
  /** Older single-endpoint spelling of the above. */
  turnCredentialEndpoint?: string;
  iceTransportPolicy?: RTCIceTransportPolicy;
  peerServer?: { host: string; port?: number; path?: string; secure?: boolean };
  /** MQTT-over-WebSocket brokers for the store-and-forward relay. Empty list disables it. */
  brokers?: string[];
}

export const DEFAULT_STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
export const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'];

const isTurn = (server: RTCIceServer) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url));
const key = (server: RTCIceServer) => JSON.stringify([server.urls, server.username ?? '']);

/** Does this TURN server answer with a relay candidate? Resolves false on timeout or error. */
export function probeTurn(server: RTCIceServer, timeoutMs = 4000): Promise<boolean> {
  return new Promise(resolve => {
    let pc: RTCPeerConnection | null = null;
    const finish = (ok: boolean) => { resolve(ok); try { pc?.close(); } catch {} pc = null; };
    try {
      pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: 'relay' });
      pc.onicecandidate = event => { if (event.candidate?.type === 'relay') finish(true); };
      pc.createDataChannel('probe');
      pc.createOffer().then(offer => pc?.setLocalDescription(offer)).catch(() => finish(false));
      setTimeout(() => finish(false), timeoutMs);
    } catch { finish(false); }
  });
}

async function mintedServers(endpoint: string): Promise<RTCIceServer[]> {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000), credentials: 'omit' });
    if (!response.ok) return [];
    const data = await response.json() as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) ? data.iceServers.filter(s => s && s.urls) : [];
  } catch { return []; }
}

export interface IcePlan { servers: RTCIceServer[]; relays: number; probed: number }

/**
 * Builds the ICE server list for this connection: STUN always, TURN only where a relay answered.
 * `probe` is injectable for tests. Results are cached briefly so reconnects do not re-probe.
 */
export async function planIce(settings: ConnectionSettings, probe: (server: RTCIceServer) => Promise<boolean> = probeTurn, cache: Storage | null = typeof sessionStorage === 'undefined' ? null : sessionStorage): Promise<IcePlan> {
  const configured = settings.iceServers ?? DEFAULT_STUN;
  const stun = configured.filter(s => !isTurn(s));
  const endpoints = [...(settings.turnCredentialEndpoints ?? []), ...(settings.turnCredentialEndpoint ? [settings.turnCredentialEndpoint] : [])];
  const minted = (await Promise.all(endpoints.map(mintedServers))).flat();
  const seen = new Set<string>();
  const turn = [...configured.filter(isTurn), ...(settings.turnServers ?? []), ...minted].filter(s => { const k = key(s); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!turn.length) return { servers: stun, relays: 0, probed: 0 };
  const cacheKey = 'stratego-ice-v1';
  try {
    const cached = JSON.parse(cache?.getItem(cacheKey) ?? 'null') as { at: number; keys: string[]; healthy: string[] } | null;
    if (cached && Date.now() - cached.at < 10 * 60 * 1000 && cached.keys.join('|') === turn.map(key).join('|')) {
      const healthy = turn.filter(s => cached.healthy.includes(key(s)));
      return { servers: [...stun, ...(healthy.length ? healthy : turn)], relays: healthy.length, probed: turn.length };
    }
  } catch {}
  const results = await Promise.all(turn.map(s => probe(s).catch(() => false)));
  const healthy = turn.filter((_, i) => results[i]);
  try { cache?.setItem(cacheKey, JSON.stringify({ at: Date.now(), keys: turn.map(key), healthy: healthy.map(key) })); } catch {}
  // With no relay answering, keep them all configured anyway: a slow probe is not proof that a relay is down.
  return { servers: [...stun, ...(healthy.length ? healthy : turn)], relays: healthy.length, probed: turn.length };
}
