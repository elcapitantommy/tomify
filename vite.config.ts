import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { lightTheme } from './scripts/light-theme.mjs'

export default defineConfig({
  // Two pages: Tomify itself, and Tomifin Downloader at /tomifin/ (tomifin/index.html).
  build: { outDir: 'dist/client', rollupOptions: { input: { main: 'index.html', tomifin: 'tomifin/index.html' } } },
  plugins: [
    react(),
    lightTheme(),
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
        // Push notification handlers (public/push-sw.js).
        importScripts: ['/push-sw.js'],
        navigateFallback: '/index.html',
        // Tomifin Downloader is its own page, not a Tomify route, so it is never answered with Tomify's index.html.
        navigateFallbackDenylist: [/^\/api\//, /^\/navidrome\//, /^\/tomifin(\/|$)/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Tomifin is always loaded from the network, so it never runs a stale cached copy.
        globIgnores: ['server/**', 'tomifin/**'],
        runtimeCaching: [{
          urlPattern: ({ request }) => request.destination === 'image',
          handler: 'CacheFirst',
          options: { cacheName: 'tomify-artwork', expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 30 } },
        }],
      },
    }),
  ],
})
