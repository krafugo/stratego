// Development-only transport: two tabs of the same browser talk through a
// BroadcastChannel instead of WebRTC. Handy on networks where direct ICE
// stalls. Wired up only when `import.meta.env.DEV` and `#transport=local`.
import type { Round } from './game.ts';
import type { Callbacks, Session } from './network.ts';

type Message = { type: 'hello'; role: string; token: string; name: string; reply: boolean } | { type: 'sync'; token: string; rounds: Round[] } | { type: 'leave'; token: string };

export class LocalConnection {
  private channel: BroadcastChannel;
  private session: Session;
  private callbacks: Callbacks;
  private connected = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(session: Session, callbacks: Callbacks) {
    this.session = session; this.callbacks = callbacks;
    this.channel = new BroadcastChannel(`stratego-local-${session.code}`);
    this.channel.onmessage = event => this.receive(event.data as Message);
    callbacks.status('waiting', 'Local room open (dev transport)');
    this.hello(false);
    this.timer = setInterval(() => { if (!this.connected) this.hello(false); }, 1000);
  }
  private hello(reply: boolean) { this.channel.postMessage({ type: 'hello', role: this.session.role, token: this.session.token, name: this.session.name, reply } satisfies Message); }
  private receive(message: Message) {
    if (message.token === this.session.token) return;
    if (message.type === 'hello') {
      if (message.role === this.session.role) return;
      if (!message.reply) this.hello(true);
      if (this.connected) return;
      this.connected = true;
      this.session.remoteToken = message.token; this.session.remoteName = message.name;
      this.callbacks.status('connected', 'Both players connected (dev transport)');
      this.callbacks.ready({ name: message.name, token: message.token });
    } else if (message.type === 'sync' && message.token === this.session.remoteToken) this.callbacks.data(message.rounds);
    else if (message.type === 'leave') { this.connected = false; this.callbacks.status('left', 'Your opponent left the room.'); }
  }
  send(rounds: Round[]) { if (this.connected) this.channel.postMessage({ type: 'sync', token: this.session.token, rounds } satisfies Message); }
  close() { this.channel.postMessage({ type: 'leave', token: this.session.token } satisfies Message); clearInterval(this.timer); this.channel.close(); }
}
