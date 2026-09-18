import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The release version (package.json) and the commit it was built from, shown in the footer so a deployment can be told apart at a glance.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    injectRegister: null,
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'Stratego', short_name: 'Stratego', description: 'Peer-to-peer Stratego for two players.',
      theme_color: '#1c2333', background_color: '#f4efe4', display: 'standalone', start_url: './', scope: './',
      icons: [{ src: './favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
  })],
  server: { watch: { ignored: ['**/work/**', '**/outputs/**'] } },
});
