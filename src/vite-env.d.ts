/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { ConnectionSettings } from 'peer-room';

declare global {
  interface Window {
    STRATEGO_CONNECTION?: ConnectionSettings;
  }
}
