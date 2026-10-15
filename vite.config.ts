import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['tomify-logo-192.png', 'apple-touch-icon-180.png'],
      manifest: {
        name: 'Tomify', short_name: 'Tomify', description: 'Your family music library.',
        theme_color: '#0d0f0e', background_color: '#0d0f0e', display: 'standalone',
        orientation: 'any', start_url: '/', scope: '/',
        icons: [
          { src: '/tomify-logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/navidrome\//],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['server/**'],
        runtimeCaching: [{
          urlPattern: ({ request }) => request.destination === 'image',
          handler: 'CacheFirst',
          options: { cacheName: 'tomify-artwork', expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 30 } },
        }],
      },
    }),
  ],
})
