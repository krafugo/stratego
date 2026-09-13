// Optional hosting configuration. This file is public: never put a private API key here.
// See README.md for a TURN credential endpoint and custom PeerServer setup.
window.STRATEGO_CONNECTION = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // turnCredentialEndpoint: 'https://your-service.example/ice',
  // peerServer: { host: 'your-peer-server.example', port: 443, path: '/', secure: true },
};
