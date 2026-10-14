import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'vite'

function mockDatabase() {
  return {
    async batch() { return [] },
    prepare() {
      return {
        bind() { return this },
        async first() { return null },
        async run() { return {} },
        async all() { return { results: [] } },
      }
    },
  }
}

await build({ configFile: new URL('../vite.config.ts', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'), logLevel: 'silent' })
await import(`./build-worker.mjs?test=${Date.now()}`)

const serviceWorker = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
const { default: worker } = await import(`../dist/server/index.js?test=${Date.now()}`)

test('generated service worker excludes API and Navidrome navigations from the SPA fallback', () => {
  assert.equal(serviceWorker.includes('denylist:[/^\\/api\\//,/^\\/navidrome\\//]'), true)
})

test('Worker handles the Spotify callback as API and returns JSON for unknown API routes', async () => {
  const env = { TOMIFY_DB: mockDatabase() }
  const callback = await worker.fetch(new Request('https://app.tomify.test/api/catalogue-auth/spotify/callback', { headers: { accept: 'text/html' } }), env)
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), 'https://app.tomify.test/playlists/import/spotify?spotify=error')

  const missing = await worker.fetch(new Request('https://app.tomify.test/api/does-not-exist', { headers: { accept: 'text/html' } }), env)
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type') || '', /^application\/json/)
  assert.deepEqual(await missing.json(), { error: 'not-found' })

  const spa = await worker.fetch(new Request('https://app.tomify.test/albums/example', { headers: { accept: 'text/html' } }), env)
  assert.equal(spa.status, 200)
  assert.match(spa.headers.get('content-type') || '', /^text\/html/)
})
