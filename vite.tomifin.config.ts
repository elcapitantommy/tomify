import { copyFile, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Tomifin Downloader on its own, for the recovery agent's local listener (docs/TOMIFIN.md, "On the tailnet").
// `pnpm build:tomifin` writes dist/tomifin-web/: index.html at the top, hashed files in assets/ and the few icons the
// page uses. The deploy scripts put that folder into each agent release as tomifin-web/. The page calls
// /api/tomifin/* on whatever origin serves it, so nothing here names a hostname.
const OUT_DIR = 'dist/tomifin-web'
// The files from public/ the page links to (tomifin/index.html and the header logo).
const ICONS = ['tomify-logo-192.png', 'apple-touch-icon-180.png', 'favicon.ico', 'favicon.svg']

function tomifinOnly(): Plugin {
  return {
    name: 'tomifin-only',
    async writeBundle() {
      // The page is tomifin/index.html in the source tree; served from the top of the folder, it is index.html.
      await rename(join(OUT_DIR, 'tomifin', 'index.html'), join(OUT_DIR, 'index.html'))
      await rmdir(join(OUT_DIR, 'tomifin'))
      for (const icon of ICONS) await copyFile(join('public', icon), join(OUT_DIR, icon))
    },
  }
}

export default defineConfig({
  // Absolute asset paths: the listener answers every page path with index.html, so relative ones would break below /.
  base: '/',
  // Only the icons above, not Tomify's service worker, manifest or anything else in public/.
  publicDir: false,
  build: { outDir: OUT_DIR, emptyOutDir: true, rollupOptions: { input: { tomifin: 'tomifin/index.html' } } },
  plugins: [react(), tomifinOnly()],
})
