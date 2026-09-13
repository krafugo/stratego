import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
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
