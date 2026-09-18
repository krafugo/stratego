/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { ConnectionSettings } from 'peer-room';

declare global {
  interface Window {
    STRATEGO_CONNECTION?: ConnectionSettings;
  }
  /** Release version and short commit, injected at build time (see vite.config.ts). */
  const __APP_VERSION__: string;
  const __APP_COMMIT__: string;
}
