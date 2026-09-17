// Optional hosting configuration. This file is public: never put a private API key here.
// See README.md for the full description of each option.
window.STRATEGO_CONNECTION = {
  // Free public STUN servers. The browser tries all of them; they only reveal the public address.
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],

  // TURN relays for networks that block direct connections (VPNs, mobile carriers, offices).
  // Every entry is probed when a room opens and only the relays that answer are used.
  // Static credentials, e.g. from a Metered "Open Relay" or ExpressTURN free account:
  turnServers: [
    // { urls: ['turn:a.relay.example:80', 'turn:a.relay.example:443?transport=tcp'], username: '…', credential: '…' },
  ],
  // Or endpoints you operate that mint short-lived credentials and answer { "iceServers": [...] }:
  turnCredentialEndpoints: [
    // 'https://your-worker.example/ice',
  ],

  // Store-and-forward relay: public MQTT brokers reached over WebSocket. All of them are used at once;
  // the game only needs one to be reachable. Messages are encrypted with a key derived from the room code.
  // An empty list turns the relay off and leaves WebRTC on its own.
  brokers: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'],

  // A custom PeerServer for WebRTC signalling: { host: 'peer.example', port: 443, path: '/', secure: true }
  // peerServer: undefined,
};
