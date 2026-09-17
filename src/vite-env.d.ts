/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { ConnectionSettings } from './ice.ts';

declare global {
  interface Window {
    STRATEGO_CONNECTION?: ConnectionSettings;
  }
}
