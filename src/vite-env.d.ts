/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface Window {
  STRATEGO_CONNECTION?: {
    iceServers?: RTCIceServer[];
    turnCredentialEndpoint?: string;
    iceTransportPolicy?: RTCIceTransportPolicy;
    peerServer?: { host: string; port?: number; path?: string; secure?: boolean };
  };
}
