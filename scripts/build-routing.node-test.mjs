import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { build } from 'vite'
import { encryptCatalogueToken } from '../worker/features/catalogue.ts'
import { parseLiveCommands } from '../worker/features/live-playback.ts'
import { openMediaToken } from '../recovery-agent/lan.mjs'
import { orderPartyQueue } from '../worker/features/party.ts'

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
const windows = process.platform === 'win32'
const bundle = spawnSync(windows ? process.env.ComSpec : 'pnpm', windows
  ? ['/d', '/s', '/c', 'pnpm exec wrangler deploy --dry-run --outdir dist/server --no-minify']
  : ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', 'dist/server', '--no-minify'], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true,
})
if (bundle.status !== 0) throw new Error(`Could not bundle the Worker for route tests.\n${bundle.stdout}\n${bundle.stderr}`)

const serviceWorker = await readFile(new URL('../dist/client/sw.js', import.meta.url), 'utf8')
const { default: builtWorker } = await import(`../dist/server/index.js?test=${Date.now()}`)
const clientIndex = await readFile(new URL('../dist/client/index.html', import.meta.url), 'utf8')
const TEST_NAVIDROME_ORIGIN = 'https://navidrome.test'
// Direct module imports do not get Cloudflare's ASSETS binding. Supply the SPA response here so the
// route suite exercises the same hand-off as the deployed Worker without changing route assertions.
const worker = { fetch(request, env = {}) { return builtWorker.fetch(request, { ASSETS: { fetch: async () => new Response(clientIndex, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }, NAVIDROME_ORIGIN: TEST_NAVIDROME_ORIGIN, ...env }) } }

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function withStaticAssetsWorker(callback) {
  const port = await availablePort()
  const windows = process.platform === 'win32'
  const command = windows ? process.env.ComSpec : 'pnpm'
  const args = windows
    ? ['/d', '/s', '/c', `pnpm exec wrangler dev --local --compatibility-date 2026-05-03 --ip 127.0.0.1 --port ${port}`]
    : ['exec', 'wrangler', 'dev', '--local', '--compatibility-date', '2026-05-03', '--ip', '127.0.0.1', '--port', String(port)]
  // detached puts pnpm, wrangler and workerd in their own process group, so the whole group can be stopped: killing
  // only pnpm leaves workerd holding the output pipes and the test process never exits.
  const child = spawn(command, args, { cwd: new URL('..', import.meta.url), windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  try {
    let ready = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited before it was ready.\n${output}`)
      try { const response = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`); ready = response.status === 404; if (ready) break } catch { /* keep waiting */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error(`wrangler dev did not become ready.\n${output}`)
    await callback(`http://127.0.0.1:${port}`)
  } finally {
    if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

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

test('Worker exposes its build version and recovery contract', async () => {
  const response = await worker.fetch(new Request('https://app.tomify.test/api/version'), {})
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.match(body.version, /^[0-9a-f]+$|^unknown$/)
  assert.equal(body.contract, 2)
})

test('the Navidrome proxy uses NAVIDROME_ORIGIN without changing the path, query, method or body', async () => {
  const originalFetch = globalThis.fetch
  let outbound = null
  globalThis.fetch = async (input, init) => { outbound = { url: String(input), init }; return new Response('proxied', { status: 200 }) }
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/navidrome/rest/ping.view?u=Tom&x=1', { method: 'POST', headers: { origin: 'https://app.tomify.test', 'content-type': 'text/plain' }, body: 'request-body' }))
    assert.equal(response.status, 200)
    assert.equal(outbound.url, TEST_NAVIDROME_ORIGIN + '/rest/ping.view?u=Tom&x=1')
    assert.equal(outbound.init.method, 'POST')
    assert.equal(await new Response(outbound.init.body).text(), 'request-body')
    assert.equal(outbound.init.headers.has('origin'), false)
  } finally { globalThis.fetch = originalFetch }
})

test('the Navidrome proxy never leaves NAVIDROME_ORIGIN, even for a path starting with //', async () => {
  const originalFetch = globalThis.fetch
  let outbound = null
  globalThis.fetch = async (input) => { outbound = new URL(String(input)); return new Response('proxied', { status: 200 }) }
  try {
    for (const path of ['/navidrome//evil.test/rest/ping.view', '/navidrome/%2F%2Fevil.test/rest/ping.view']) {
      outbound = null
      await worker.fetch(new Request('https://app.tomify.test' + path))
      assert.equal(outbound?.origin, TEST_NAVIDROME_ORIGIN, path)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('a missing or invalid NAVIDROME_ORIGIN fails closed without contacting a fallback host', async () => {
  const originalFetch = globalThis.fetch
  const outbound = []
  globalThis.fetch = async (input) => { outbound.push(String(input)); return Response.json({}) }
  const request = () => new Request('https://app.tomify.test/api/recovery-agent/status', { headers: { 'x-tomify-user': 'configuration-test', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } })
  try {
    for (const NAVIDROME_ORIGIN of [undefined, 'http://navidrome.test', 'not a URL']) {
      const response = await builtWorker.fetch(request(), { RECOVERY_AGENT_URL: 'https://agent.tomify.test', ...(NAVIDROME_ORIGIN ? { NAVIDROME_ORIGIN } : {}) })
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'navidrome-unavailable', message: 'NAVIDROME_ORIGIN must be configured as a valid https:// origin.' })
    }
    assert.deepEqual(outbound, [])
  } finally { globalThis.fetch = originalFetch }
})

test('Worker exposes authenticated recovery-agent version details to Settings', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') return Response.json({ version: 'agent123', contract: 2, backends: [] })
    return new Response('{}', { status: 404 })
  }
  try {
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery-agent/status', { headers }), { RECOVERY_AGENT_URL: 'https://agent-settings.tomify.test' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { version: 'agent123', contract: 2 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

function completenessDatabase() {
  const tracklists = new Map()
  const recoveryItems = []
  const statement = (sql) => ({
    sql, args: [],
    bind(...args) { this.args = args; return this },
    async first() {
      if (sql.includes('FROM release_tracklists')) return tracklists.get(this.args[0]) || null
      return null
    },
    async all() { return { results: sql.includes('FROM recovery_items') ? recoveryItems.map(({ id, artist, title, musicBrainzId, status }) => ({ id, artist, title, musicBrainzId, status })) : [] } },
    async run() {
      if (sql.startsWith('INSERT INTO release_tracklists')) tracklists.set(this.args[0], { tracklistJson: this.args[4], editionsJson: this.args[5] })
      return {}
    },
  })
  return {
    recoveryItems,
    prepare: statement,
    async batch(statements) {
      for (const value of statements) if (value.sql.startsWith('INSERT INTO recovery_items')) {
        for (let offset = 0; offset < value.args.length; offset += 10) {
          const [id, username, artist, title, album, duration, trackNumber, discNumber, musicBrainzId, sourceJson] = value.args.slice(offset, offset + 10)
          recoveryItems.push({ id, username, artist, title, album, duration, trackNumber, discNumber, musicBrainzId, source: JSON.parse(sourceJson), status: 'missing' })
        }
      }
      return []
    },
  }
}

test('album completeness resolves a tagged release tracklist and adds only missing tracks to Recovery once', async () => {
  const releaseId = '11111111-1111-4111-8111-111111111111'
  const groupId = '22222222-2222-4222-8222-222222222222'
  const recordingId = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`
  const requested = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    requested.push(url.hostname + url.pathname)
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === `/ws/2/release/${releaseId}`) return Response.json({ id: releaseId, title: 'Flood', date: '1990-01-15', country: 'US', status: 'Official', 'release-group': { id: groupId }, 'artist-credit': [{ name: 'They Might Be Giants' }], media: [{ position: 1, format: 'CD', tracks: ['Theme From Flood', 'Birdhouse in Your Soul', 'Lucky Ball and Chain'].map((title, index) => ({ position: index + 1, title, length: 60_000 + index * 1000, recording: { id: recordingId(index + 1) } })) }] })
    if (url.pathname === '/ws/2/release' && url.searchParams.get('release-group') === groupId) return Response.json({ releases: [{ id: releaseId, title: 'Flood', status: 'Official', date: '1990-01-15', country: 'US', media: [{ format: 'CD', 'track-count': 3 }] }] })
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: completenessDatabase() }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const call = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/album-completeness/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env)

    const unauthenticated = await worker.fetch(new Request('https://app.tomify.test/api/album-completeness/tracklist', { method: 'POST', body: '{}' }), env)
    assert.equal(unauthenticated.status, 401)
    assert.equal((await call('recovery', { albumId: 'album-1', trackKeys: ['1-1'] })).status, 409)

    const tracklist = await call('tracklist', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants', musicBrainzId: releaseId, localTrackCount: 1 })
    assert.equal(tracklist.status, 200)
    const body = await tracklist.json()
    assert.equal(body.tracklist.source, 'tagged')
    assert.deepEqual(body.tracklist.tracks.map((track) => track.key), ['1-1', '1-2', '1-3'])
    assert.equal(body.editions.length, 1)
    assert.deepEqual(body.recovery, {})

    const lookups = requested.filter((path) => path.startsWith('musicbrainz.org')).length
    assert.equal((await call('tracklist', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants', localTrackCount: 1 })).status, 200)
    assert.equal(requested.filter((path) => path.startsWith('musicbrainz.org')).length, lookups, 'cached tracklists do not call MusicBrainz again')

    const added = await call('recovery', { albumId: 'album-1', trackKeys: ['1-1', '1-3', 'not-a-track'] })
    assert.equal(added.status, 201)
    assert.deepEqual(await added.json().then(({ created, existing }) => ({ created, existing })), { created: 2, existing: 0 })
    assert.deepEqual(env.TOMIFY_DB.recoveryItems.map(({ title, album, trackNumber, discNumber, musicBrainzId, source }) => ({ title, album, trackNumber, discNumber, musicBrainzId, origin: source.origin, releaseId: source.releaseId })), [
      { title: 'Theme From Flood', album: 'Flood', trackNumber: 1, discNumber: 1, musicBrainzId: recordingId(1), origin: 'album-completeness', releaseId },
      { title: 'Lucky Ball and Chain', album: 'Flood', trackNumber: 3, discNumber: 1, musicBrainzId: recordingId(3), origin: 'album-completeness', releaseId },
    ])

    const repeated = await call('recovery', { albumId: 'album-1', trackKeys: ['1-1', '1-3'] })
    assert.equal(repeated.status, 200)
    assert.deepEqual(await repeated.json().then(({ created, existing }) => ({ created, existing })), { created: 0, existing: 2 })
    assert.equal(env.TOMIFY_DB.recoveryItems.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('album completeness compares a twelve-track album with the album, not its same-titled one-track single', async () => {
  const singleGroup = '44444444-4444-4444-8444-444444444444'
  const albumGroup = '55555555-5555-4555-8555-555555555555'
  const singleRelease = '66666666-6666-4666-8666-666666666666'
  const albumRelease = '77777777-7777-4777-8777-777777777777'
  const titles = ['Your Time Has Come', 'Out of Exile', 'Be Yourself', 'Doesn\u2019t Remind Me', 'Drown Me Slowly', 'Heaven\u2019s Dead', 'The Worm', 'Man or Animal', 'Yesterday to Tomorrow', 'Dandelion', '#1 Zero', 'The Curse']
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    // MusicBrainz ranks the promo single first; both share the title, artist and year.
    if (url.pathname === '/ws/2/release-group/') return Response.json({ 'release-groups': [
      { id: singleGroup, title: 'Out of Exile', score: 100, 'primary-type': 'Single', 'first-release-date': '2005', 'artist-credit': [{ name: 'Audioslave' }] },
      { id: albumGroup, title: 'Out of Exile', score: 100, 'primary-type': 'Album', 'first-release-date': '2005-05-23', 'artist-credit': [{ name: 'Audioslave' }] },
    ] })
    if (url.pathname === '/ws/2/release' && url.searchParams.get('release-group') === singleGroup) return Response.json({ releases: [{ id: singleRelease, title: 'Out of Exile', status: 'Promotion', date: '2005', country: 'US', media: [{ format: 'CD-R', 'track-count': 1 }] }] })
    if (url.pathname === '/ws/2/release' && url.searchParams.get('release-group') === albumGroup) return Response.json({ releases: [{ id: albumRelease, title: 'Out of Exile', status: 'Official', date: '2005-05-23', country: 'US', media: [{ format: 'CD', 'track-count': 12 }] }] })
    if (url.pathname === `/ws/2/release/${singleRelease}`) return Response.json({ id: singleRelease, title: 'Out of Exile', date: '2005', country: 'US', status: 'Promotion', 'release-group': { id: singleGroup }, 'artist-credit': [{ name: 'Audioslave' }], media: [{ position: 1, format: 'CD-R', 'track-count': 1, tracks: [{ position: 1, title: 'Out of Exile' }] }] })
    if (url.pathname === `/ws/2/release/${albumRelease}`) return Response.json({ id: albumRelease, title: 'Out of Exile', date: '2005-05-23', country: 'US', status: 'Official', 'release-group': { id: albumGroup }, 'artist-credit': [{ name: 'Audioslave' }], media: [{ position: 1, format: 'CD', 'track-count': 12, tracks: titles.map((title, index) => ({ position: index + 1, title })) }] })
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: completenessDatabase() }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const call = (body) => worker.fetch(new Request('https://app.tomify.test/api/album-completeness/tracklist', { method: 'POST', headers, body: JSON.stringify(body) }), env)

    const searched = await (await call({ albumId: 'exile', name: 'Out Of Exile', artist: 'Audioslave', year: 2005, localTrackCount: 12 })).json()
    assert.equal(searched.tracklist.releaseId, albumRelease)
    assert.equal(searched.tracklist.tracks.length, 12)

    // A file tagged with the single's release ID falls back to the album too.
    const tagged = await (await call({ albumId: 'exile-tagged', name: 'Out Of Exile', artist: 'Audioslave', year: 2005, musicBrainzId: singleRelease, localTrackCount: 12 })).json()
    assert.equal(tagged.tracklist.releaseId, albumRelease)
    assert.equal(tagged.tracklist.source, 'auto')

    // A tracklist cached before this fix is resolved again on the next load, without pressing refresh.
    const stale = { albumId: 'exile-cached', releaseId: singleRelease, releaseGroupId: singleGroup, title: 'Out of Exile', source: 'auto', tracks: [{ key: '1-1', disc: 1, number: 1, title: 'Out of Exile' }] }
    await env.TOMIFY_DB.prepare('INSERT INTO release_tracklists').bind('exile-cached', singleRelease, singleGroup, 'auto', JSON.stringify(stale), '[]').run()
    const refreshed = await (await call({ albumId: 'exile-cached', name: 'Out Of Exile', artist: 'Audioslave', year: 2005, localTrackCount: 12 })).json()
    assert.equal(refreshed.tracklist.releaseId, albumRelease)

    // A one-track local copy of the single still matches the single.
    const single = await (await call({ albumId: 'exile-single', name: 'Out Of Exile', artist: 'Audioslave', year: 2005, localTrackCount: 1 })).json()
    assert.equal(single.tracklist.releaseId, singleRelease)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('album completeness reports an unreachable MusicBrainz as a JSON 502', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (['/rest/ping.view', '/rest/getUser.view'].includes(new URL(String(input)).pathname)) return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    throw new TypeError('network unreachable')
  }
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/album-completeness/tracklist', { method: 'POST', headers: { 'x-tomify-user': 'anna', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }, body: JSON.stringify({ albumId: 'album-2', name: 'Lincoln', artist: 'They Might Be Giants', localTrackCount: 3 }) }), { TOMIFY_DB: completenessDatabase() })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error, 'musicbrainz-unavailable')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function wantedMusicDatabase() {
  const rows = new Map()
  const statement = (sql) => ({
    sql, args: [],
    bind(...args) { this.args = args; return this },
    async first() { return sql.startsWith('SELECT id, artist, title, album') ? rows.get(this.args[1]) || null : null },
    async all() { return { results: [] } },
    async run() {
      if (sql.startsWith('INSERT INTO recovery_items')) {
        const [id, username, artist, title, album] = this.args
        rows.set(id, { id, username, artist, title, album, status: 'missing' })
      }
      return {}
    },
  })
  return { rows, prepare: statement, async batch() { return [] } }
}

test('Recovery rejects old or unversioned agents and accepts contract 2', async () => {
  const searched = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') {
      if (url.hostname === 'agent-old.tomify.test') return Response.json({ version: 'old', contract: 1, backends: [] })
      if (url.hostname === 'agent-current.tomify.test') return Response.json({ version: 'current', contract: 2, backends: [] })
      return Response.json({ version: 'legacy', backends: [] })
    }
    if (url.pathname === '/v1/search') { searched.push(url.hostname); return Response.json({ candidates: [] }) }
    return new Response('{}', { status: 404 })
  }
  try {
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const search = async (agent) => {
      const env = { TOMIFY_DB: wantedMusicDatabase(), RECOVERY_AGENT_URL: `https://${agent}.tomify.test` }
      const added = await worker.fetch(new Request('https://app.tomify.test/api/recovery', { method: 'POST', headers, body: JSON.stringify({ artist: 'They Might Be Giants', album: 'Flood' }) }), env).then((response) => response.json())
      return worker.fetch(new Request(`https://app.tomify.test/api/recovery/${added.item.id}/search`, { method: 'POST', headers, body: JSON.stringify({ backend: 'usenet', searchFields: ['artist', 'album'] }) }), env)
    }

    const old = await search('agent-old')
    assert.equal(old.status, 409)
    assert.deepEqual(await old.json().then(({ error, message }) => ({ error, message })), { error: 'recovery-agent-outdated', message: 'The recovery agent is out of date. Redeploy it using docs/RECOVERY.md, “Updating the recovery agent”: https://github.com/elcapitantommy/tomify/blob/main/docs/RECOVERY.md#updating-the-recovery-agent' })
    assert.equal((await search('agent-current')).status, 200)
    const legacy = await search('agent-legacy')
    assert.equal(legacy.status, 409)
    assert.equal((await legacy.json()).error, 'recovery-agent-outdated')
    assert.deepEqual(searched, ['agent-current.tomify.test'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Recovery accepts wanted music from any mix of artist, album and track and searches Usenet with combined fields', async () => {
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') return Response.json({ version: 'test', contract: 2, backends: [] })
    if (url.pathname === '/v1/search') { agentRequests.push(JSON.parse(init.body)); return Response.json({ candidates: [] }) }
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: wantedMusicDatabase(), RECOVERY_AGENT_URL: 'https://agent.tomify.test' }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const post = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/recovery${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env)

    const empty = await post('', { artist: ' ', title: '', album: '' })
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).error, 'invalid-wanted-music')

    const added = await post('', { artist: 'They Might Be Giants', album: 'Flood' })
    assert.equal(added.status, 201)
    const { item } = await added.json()
    assert.deepEqual({ artist: item.artist, title: item.title, album: item.album }, { artist: 'They Might Be Giants', title: '', album: 'Flood' })

    assert.equal((await post(`/${item.id}/search`, { backend: 'usenet', searchFields: ['genre'] })).status, 400)
    assert.equal((await post(`/${item.id}/search`, { backend: 'usenet', searchFields: ['album', 'artist'] })).status, 200)
    assert.equal((await post(`/${item.id}/search`, { backend: 'usenet', searchMode: 'release' })).status, 200)
    assert.deepEqual(agentRequests.map(({ searchFields, searchMode }) => ({ searchFields, searchMode })), [
      { searchFields: ['artist', 'album'], searchMode: 'release' },
      { searchFields: undefined, searchMode: 'release' },
    ])
    assert.deepEqual(agentRequests[0].track, { artist: 'They Might Be Giants', title: '', album: 'Flood', duration: null })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Recovery imports the rest of a single-track Usenet download and keeps every track for deletion', async () => {
  const candidate = { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: '/recovery/Recovered Tracks/Birdhouse in Your Soul.mp3', provenanceJson: JSON.stringify({ source: 'usenet', searchMode: 'track', job: { id: 'job-1', status: 'completed', progress: 100 }, importedCount: 1, importedTracks: [{ path: '/recovery/Recovered Tracks/Birdhouse in Your Soul.mp3' }] }) }
  const updates = []
  const db = {
    prepare: (sql) => ({
      sql, args: [],
      bind(...args) { this.args = args; return this },
      async first() { return sql.startsWith('SELECT id, artist, title, album') ? { id: 'recovery-1', artist: 'They Might Be Giants', title: 'Birdhouse in Your Soul', status: 'needs-upgrade' } : null },
      async all() { return { results: sql.includes('FROM recovery_candidates') ? [candidate] : [] } },
      async run() { if (sql.startsWith('UPDATE recovery_candidates SET provenance_json')) { updates.push(this.args); candidate.provenanceJson = this.args[0] } return {} },
    }),
    async batch() { return [] },
  }
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') return Response.json({ version: 'test', contract: 2, backends: [] })
    if (url.pathname === '/v1/jobs/import-remaining') {
      agentRequests.push(JSON.parse(init.body))
      return Response.json({ result: { importedCount: 2, artist: 'They Might Be Giants', album: 'Flood', importedTracks: [{ path: '/recovery/They Might Be Giants/Flood/01 - Theme from Flood.mp3', title: 'Theme from Flood' }, { path: '/recovery/They Might Be Giants/Flood/03 - Lucky Ball and Chain.mp3', title: 'Lucky Ball and Chain' }] } })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/import-remaining', { method: 'POST', headers }), env)
    assert.equal(response.status, 200)
    assert.deepEqual(agentRequests, [{ jobId: 'job-1' }])
    const provenance = JSON.parse(updates[0][0])
    assert.equal(provenance.importedCount, 3)
    assert.deepEqual(provenance.importedTracks.map((track) => track.path.split('/').pop()), ['Birdhouse in Your Soul.mp3', '01 - Theme from Flood.mp3', '03 - Lucky Ball and Chain.mp3'])
    assert.deepEqual(provenance.importedRelease, { artist: 'They Might Be Giants', album: 'Flood' })
    assert.equal(typeof provenance.remainingImportedAt, 'string')
    const { item } = await response.json()
    assert.equal(item.candidates[0].provenance.importedCount, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function artworkDatabase() {
  const rows = new Map()
  const statement = (sql) => ({
    sql, args: [],
    bind(...args) { this.args = args; return this },
    async first() {
      if (sql.includes('FROM album_artwork')) return rows.get(this.args[0]) || null
      return null
    },
    async all() { return { results: sql.includes('FROM album_artwork') ? [...rows.values()] : [] } },
    async run() {
      if (sql.startsWith('INSERT INTO album_artwork (')) {
        const [albumId, provider, providerId, url, width, height, confidence, source, providerAlbum, providerArtist, storeUrl] = this.args
        rows.set(albumId, { albumId, provider, providerId, url, width, height, confidence, source, providerAlbum, providerArtist, storeUrl, updatedAt: 'now' })
      }
      if (sql.startsWith('DELETE FROM album_artwork WHERE')) rows.delete(this.args[0])
      return {}
    },
  })
  return { rows, prepare: statement, async batch() { return [] } }
}

test('album artwork falls back to Spotify, applies a confident match and never replaces a manual choice', async () => {
  const spotifySearches = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'spotify-token', expires_in: 3600 })
    if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] })
    if (url.hostname === 'api.deezer.com') return Response.json({ data: [] })
    if (url.hostname === 'api.spotify.com') {
      spotifySearches.push(url.searchParams.get('q'))
      const items = url.searchParams.get('q')?.startsWith('album:Flood ') ? [{ id: 'sp-flood', name: 'Flood (Deluxe Edition)', release_date: '1990-01-15', artists: [{ name: 'They Might Be Giants' }], images: [{ url: 'https://i.scdn.co/image/flood-640', width: 640, height: 640 }, { url: 'https://i.scdn.co/image/flood-64', width: 64, height: 64 }], external_urls: { spotify: 'https://open.spotify.com/album/sp-flood' } }] : []
      return Response.json({ albums: { items } })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: artworkDatabase(), SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const call = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/album-artwork/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env)
    const album = { albumId: 'album-1', name: 'Flood (2013 Remaster)', artist: 'They Might Be Giants', year: 1990 }

    assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/album-artwork'), env)).status, 401)

    const auto = await call('auto', album)
    assert.equal(auto.status, 200)
    const applied = await auto.json()
    assert.equal(applied.applied, true)
    assert.equal(applied.item.url, 'https://i.scdn.co/image/flood-640')
    assert.equal(applied.item.source, 'auto')
    assert.equal(applied.item.storeUrl, 'https://open.spotify.com/album/sp-flood')
    assert.deepEqual(spotifySearches, ['album:Flood artist:They Might Be Giants'], 'the edition qualifier is dropped from the search and from matching')

    const unchanged = await call('auto', album).then((response) => response.json())
    assert.equal(unchanged.applied, false)
    assert.equal(unchanged.reason, 'unchanged')

    const kept = await call('select', { albumId: 'album-1', provider: 'library' }).then((response) => response.json())
    assert.equal(kept.item.provider, 'library')
    assert.equal(kept.item.source, 'manual')
    const searchesBefore = spotifySearches.length
    const skipped = await call('auto', album).then((response) => response.json())
    assert.equal(skipped.reason, 'manual-choice')
    assert.equal(spotifySearches.length, searchesBefore, 'a manual choice skips the Spotify lookup entirely')

    assert.equal((await call('select', { albumId: 'album-1', candidate: { provider: 'spotify', url: 'https://evil.example/cover.jpg' } })).status, 400)

    const listed = await worker.fetch(new Request('https://app.tomify.test/api/album-artwork', { headers }), env).then((response) => response.json())
    assert.deepEqual(listed.providers, ['apple', 'deezer', 'spotify'])
    assert.deepEqual(listed.items.map((item) => [item.albumId, item.provider]), [['album-1', 'library']])

    await call('reset', { albumId: 'album-1' })
    assert.equal(env.TOMIFY_DB.rows.size, 0)

    const none = await call('auto', { albumId: 'album-2', name: 'Unknown Thing', artist: 'Nobody' }).then((response) => response.json())
    assert.deepEqual([none.applied, none.reason], [false, 'no-match'])
    assert.deepEqual(spotifySearches.slice(-2), ['album:Unknown Thing artist:Nobody', 'Unknown Thing Nobody'], 'an unfiltered search is tried before giving up')
  } finally {
    globalThis.fetch = originalFetch
  }
})

const artworkHeaders = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
const artworkCall = (env, path, body) => worker.fetch(new Request(`https://app.tomify.test/api/album-artwork/${path}`, { method: 'POST', headers: artworkHeaders, body: JSON.stringify(body) }), env)
const floodApple = { collectionId: 123, collectionName: 'Flood', artistName: 'They Might Be Giants', releaseDate: '1990-01-15T08:00:00Z', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/flood/100x100bb.jpg', collectionViewUrl: 'https://music.apple.com/gb/album/flood/123' }
const floodDeezer = { id: 456, title: 'Flood', link: 'https://www.deezer.com/album/456', cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/flood/1000x1000-000000-80-0-0.jpg', artist: { name: 'They Might Be Giants' } }

async function withArtworkFetch(routes, run) {
  const requested = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'app-token', expires_in: 3600 })
    requested.push({ host: url.hostname, query: url.searchParams.get('q') || url.searchParams.get('term'), authorization: init?.headers?.authorization })
    return routes[url.hostname]?.(url) ?? new Response('{}', { status: 404 })
  }
  try { await run(requested) } finally { globalThis.fetch = originalFetch }
}

test('album artwork prefers Apple at 1200px without Spotify credentials and stops before Deezer', async () => {
  await withArtworkFetch({ 'itunes.apple.com': () => Response.json({ results: [floodApple] }), 'api.deezer.com': () => Response.json({ data: [floodDeezer] }) }, async (requested) => {
    const env = { TOMIFY_DB: artworkDatabase() }
    const listed = await worker.fetch(new Request('https://app.tomify.test/api/album-artwork', { headers: artworkHeaders }), env).then((response) => response.json())
    assert.deepEqual(listed.providers, ['apple', 'deezer'])
    const body = await artworkCall(env, 'auto', { albumId: 'album-1', name: 'Flood (Deluxe)', artist: 'They Might Be Giants', year: 1990 }).then((response) => response.json())
    assert.equal(body.applied, true)
    assert.equal(body.item.provider, 'apple')
    assert.equal(body.item.url, 'https://is1-ssl.mzstatic.com/image/thumb/Music/flood/1200x1200bb.jpg')
    assert.equal(body.item.storeUrl, 'https://music.apple.com/gb/album/flood/123')
    assert.deepEqual(requested.map(({ host, query }) => [host, query]), [['itunes.apple.com', 'Flood They Might Be Giants']])

    const lookup = await artworkCall(env, 'lookup', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' }).then((response) => response.json())
    assert.deepEqual(lookup.candidates.map((candidate) => candidate.provider), ['apple', 'deezer'], 'the album page sees every catalogue, Apple first')
    assert.equal((await artworkCall(env, 'select', { albumId: 'album-1', candidate: lookup.candidates[1] }).then((response) => response.json())).item.provider, 'deezer')
  })
})

test('album artwork uses Deezer when Apple is rate limiting or has no match', async () => {
  let appleStatus = 403
  await withArtworkFetch({ 'itunes.apple.com': () => appleStatus === 403 ? new Response('', { status: 403 }) : Response.json({ results: [] }), 'api.deezer.com': () => Response.json({ data: [floodDeezer] }) }, async (requested) => {
    const env = { TOMIFY_DB: artworkDatabase() }
    const throttled = await artworkCall(env, 'auto', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' }).then((response) => response.json())
    assert.deepEqual([throttled.applied, throttled.item.provider, throttled.item.url], [true, 'deezer', floodDeezer.cover_xl])
    appleStatus = 200
    const missing = await artworkCall(env, 'auto', { albumId: 'album-2', name: 'Flood', artist: 'They Might Be Giants' }).then((response) => response.json())
    assert.equal(missing.item.provider, 'deezer')
    assert.deepEqual(requested.filter(({ host }) => host === 'api.deezer.com').map(({ query }) => query)[0], 'artist:"They Might Be Giants" album:"Flood"')
  })
})

test('album artwork reports rate limits and errors only when every catalogue fails', async () => {
  let failing = 'rate'
  const fail = (headers) => () => failing === 'rate' ? new Response('{}', { status: 429, headers }) : new Response('{}', { status: 500 })
  await withArtworkFetch({ 'itunes.apple.com': () => new Response('', { status: failing === 'rate' ? 403 : 500 }), 'api.deezer.com': fail({}), 'api.spotify.com': fail({ 'retry-after': '7' }) }, async () => {
    const env = { TOMIFY_DB: artworkDatabase(), SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' }
    const limited = await artworkCall(env, 'auto', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json().then(({ error, retryAfter }) => ({ error, retryAfter })), { error: 'rate-limited', retryAfter: 5 }, 'retries as soon as the quickest catalogue allows')
    failing = 'error'
    const failed = await artworkCall(env, 'auto', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' })
    assert.equal(failed.status, 502)
    const body = await failed.json()
    assert.equal(body.error, 'apple-error')
    assert.match(body.message, /Apple search returned HTTP 500\. Deezer search returned HTTP 500\. Spotify search returned HTTP 500\./)
    assert.equal(env.TOMIFY_DB.rows.size, 0)
  })
})

test('album artwork searches Spotify as the connected account and explains a 403', async () => {
  const env = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret', SPOTIFY_TOKEN_ENCRYPTION_KEY: 'test-key' }
  const encryptedToken = await encryptCatalogueToken(env, { accessToken: 'user-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
  const database = artworkDatabase()
  const prepare = database.prepare
  database.prepare = (sql) => sql.includes('FROM catalogue_provider_tokens') ? { bind() { return this }, async first() { return { encryptedToken } } } : prepare(sql)
  const unavailable = () => new Response('{}', { status: 500 })
  await withArtworkFetch({ 'itunes.apple.com': unavailable, 'api.deezer.com': unavailable, 'api.spotify.com': () => Response.json({ error: { status: 403, message: 'Active premium subscription required for the owner of the app.' } }, { status: 403 }) }, async (requested) => {
    const response = await artworkCall({ ...env, TOMIFY_DB: database }, 'auto', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /Spotify search returned HTTP 403: Active premium subscription required for the owner of the app\. Since March 2026 Spotify refuses Development Mode apps whose owner has no Premium subscription\./)
    // The app token is cached across tests, so only check that the retry did not reuse the account token.
    assert.deepEqual(requested.filter(({ host }) => host === 'api.spotify.com').map(({ authorization }) => authorization === 'Bearer user-token' ? 'account' : 'app'), ['account', 'app'], 'a 403 for the connected account is retried with the app credentials')
  })
  const noMatch = () => Response.json({ results: [], data: [] })
  await withArtworkFetch({ 'itunes.apple.com': noMatch, 'api.deezer.com': noMatch, 'api.spotify.com': () => Response.json({ error: { status: 403, message: 'Active premium subscription required for the owner of the app.' } }, { status: 403 }) }, async () => {
    const lookup = await artworkCall({ ...env, TOMIFY_DB: database }, 'lookup', { albumId: 'album-1', name: 'Gold - Disc 1', artist: 'Earth, Wind & Fire' }).then((response) => response.json())
    assert.deepEqual(lookup.candidates, [])
    assert.deepEqual(lookup.query, { album: 'Gold', artist: 'Earth, Wind & Fire' })
    assert.deepEqual(lookup.searched, ['apple', 'deezer'])
    assert.deepEqual(lookup.failed.map(({ provider }) => provider), ['spotify'], 'a failed catalogue is reported even when the others answer')
    assert.match(lookup.failed[0].message, /owner of the app/)
  })
})

test('album artwork retries Spotify with the app credentials when an old connection is refused', async () => {
  const env = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret', SPOTIFY_TOKEN_ENCRYPTION_KEY: 'test-key' }
  const encryptedToken = await encryptCatalogueToken(env, { accessToken: 'old-app-user-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
  const database = artworkDatabase()
  const prepare = database.prepare
  database.prepare = (sql) => sql.includes('FROM catalogue_provider_tokens') ? { bind() { return this }, async first() { return { encryptedToken } } } : prepare(sql)
  const noMatch = () => Response.json({ results: [], data: [] })
  const gold = { id: 'sp-gold', name: 'Gold', release_date: '2005-01-01', artists: [{ name: 'Earth, Wind & Fire' }], images: [{ url: 'https://i.scdn.co/image/gold', width: 640, height: 640 }] }
  const originalFetch = globalThis.fetch
  let spotifyReply = () => new Response('{}', { status: 500 })
  // withArtworkFetch records each request's authorization header, so the route reads it back from there.
  await withArtworkFetch({ 'itunes.apple.com': noMatch, 'api.deezer.com': noMatch, 'api.spotify.com': () => spotifyReply() }, async (requested) => {
    spotifyReply = () => requested.at(-1).authorization === 'Bearer old-app-user-token' ? Response.json({ error: { status: 403 } }, { status: 403 }) : Response.json({ albums: { items: [gold] } })
    const lookup = await artworkCall({ ...env, TOMIFY_DB: database }, 'lookup', { albumId: 'album-1', name: 'Gold', artist: 'Earth, Wind & Fire' }).then((response) => response.json())
    assert.deepEqual(lookup.candidates.map((candidate) => candidate.providerId), ['sp-gold'])
    assert.deepEqual(lookup.failed, [])
    assert.deepEqual(requested.filter(({ host }) => host === 'api.spotify.com').map(({ authorization }) => authorization === 'Bearer old-app-user-token' ? 'account' : 'app'), ['account', 'app'])
  })
  assert.equal(globalThis.fetch, originalFetch)
})

test('Recovery explains an out-of-date agent instead of showing not-found', async () => {
  const candidate = { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: '/recovery/track.mp3', provenanceJson: JSON.stringify({ job: { id: 'job-1', status: 'completed', progress: 100 }, importedTracks: [{ path: '/recovery/track.mp3' }] }) }
  const db = {
    prepare: (sql) => ({ sql, bind() { return this }, async first() { return sql.startsWith('SELECT id, artist, title, album') ? { id: 'recovery-1', artist: 'A', title: 'T', status: 'needs-upgrade' } : null }, async all() { return { results: sql.includes('FROM recovery_candidates') ? [candidate] : [] } }, async run() { return {} } }),
    async batch() { return [] },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => ['/rest/ping.view', '/rest/getUser.view'].includes(new URL(String(input)).pathname) ? Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } }) : Response.json({ error: 'not-found' }, { status: 404 })
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/import-remaining', { method: 'POST', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /recovery agent is out of date/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Recovery hands a pasted torrent link to the agent as a torrent search', async () => {
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') return Response.json({ version: 'test', contract: 2, backends: [] })
    if (url.pathname === '/v1/search') { agentRequests.push(JSON.parse(init.body)); return Response.json({ candidates: [{ externalId: 'torrent-external', url: 'magnet:?xt=urn:btih:abc', title: 'Flood', channel: 'Torrent link', provenance: { providerType: 'torrent', searchMode: 'release' } }] }) }
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: wantedMusicDatabase(), RECOVERY_AGENT_URL: 'https://agent.tomify.test' }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const post = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/recovery${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env)
    const { item } = await (await post('', { artist: 'They Might Be Giants', album: 'Flood' })).json()
    const blank = await post(`/${item.id}/search`, { backend: 'torrent', link: '   ' })
    assert.equal(blank.status, 400)
    assert.equal((await blank.json()).error, 'invalid-torrent-link')
    assert.equal((await post(`/${item.id}/search`, { backend: 'torrent', link: '  magnet:?xt=urn:btih:abc&tr=https://tracker.test/passkey  ' })).status, 200)
    assert.equal(agentRequests.length, 1)
    assert.equal(agentRequests[0].backend, 'torrent')
    assert.equal(agentRequests[0].link, 'magnet:?xt=urn:btih:abc&tr=https://tracker.test/passkey')
    assert.deepEqual(agentRequests[0].track, { artist: 'They Might Be Giants', title: '', album: 'Flood', duration: null })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Recovery searches torrents by the chosen fields when no link is pasted', async () => {
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/status') return Response.json({ version: 'test', contract: 2, backends: [] })
    if (url.pathname === '/v1/search') { agentRequests.push(JSON.parse(init.body)); return Response.json({ candidates: [{ externalId: 'torrent-search', url: 'https://thepiratebay.org/description.php?id=1', title: 'They Might Be Giants - Flood (1990) FLAC', channel: 'thepiratebay.org', provenance: { providerType: 'torrent', providerId: 'qbittorrent-search', seeds: 42, searchMode: 'release' } }] }) }
    return new Response('{}', { status: 404 })
  }
  try {
    const env = { TOMIFY_DB: wantedMusicDatabase(), RECOVERY_AGENT_URL: 'https://agent.tomify.test' }
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
    const post = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/recovery${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env)
    const { item } = await (await post('', { artist: 'They Might Be Giants', album: 'Flood' })).json()
    const none = await post(`/${item.id}/search`, { backend: 'torrent', searchFields: [] })
    assert.equal(none.status, 400)
    assert.match((await none.json()).message, /search torrents/)
    assert.equal((await post(`/${item.id}/search`, { backend: 'torrent', searchFields: ['artist', 'album'] })).status, 200)
    assert.equal(agentRequests.length, 1)
    assert.equal(agentRequests[0].backend, 'torrent')
    assert.equal('link' in agentRequests[0], false)
    assert.deepEqual(agentRequests[0].searchFields, ['artist', 'album'])
    assert.equal(agentRequests[0].searchMode, 'release')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function torrentDeleteDatabase(candidate, status) {
  const deleted = []
  return {
    deleted,
    prepare: (sql) => ({
      sql, args: [],
      bind(...args) { this.args = args; return this },
      async first() { return sql.startsWith('SELECT id, artist, title, album') ? { id: 'recovery-1', artist: 'They Might Be Giants', title: '', album: 'Flood', status } : null },
      async all() { return { results: sql.includes('FROM recovery_candidates') ? [candidate] : [] } },
      async run() { return {} },
    }),
    async batch(statements) { deleted.push(...statements.map((statement) => statement.sql).filter((sql) => sql.startsWith('DELETE'))); return [] },
  }
}

test('deleting a downloading torrent item removes the torrent first, plus anything it imported meanwhile', async () => {
  const candidate = { id: 'candidate-1', backend: 'torrent', selected: 1, importedPath: null, provenanceJson: JSON.stringify({ job: { id: 'job-1', status: 'downloading', progress: 40 } }) }
  const db = torrentDeleteDatabase(candidate, 'downloading')
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/jobs/cancel') { agentRequests.push(['cancel', JSON.parse(init.body)]); return Response.json({ cancelled: true, torrentRemoved: true, importedPaths: ['/recovery/They Might Be Giants/Flood/01 - Theme from Flood.flac'] }) }
    if (url.pathname === '/v1/delete') { agentRequests.push(['delete', JSON.parse(init.body)]); return Response.json({ deleted: [] }) }
    return new Response('{}', { status: 404 })
  }
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1', { method: 'DELETE', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 200)
    assert.deepEqual(agentRequests, [['cancel', { jobId: 'job-1' }], ['delete', { importedPaths: ['/recovery/They Might Be Giants/Flood/01 - Theme from Flood.flac'] }]])
    assert.equal(db.deleted.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a torrent item is kept when qBittorrent cannot remove its torrent, and running Usenet jobs still block deletion', async () => {
  const torrent = { id: 'candidate-1', backend: 'torrent', selected: 1, importedPath: null, provenanceJson: JSON.stringify({ job: { id: 'job-1', status: 'downloading', progress: 40 } }) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname === '/v1/jobs/cancel') return Response.json({ error: 'recovery-agent-error', message: 'qBittorrent rejected the configured username or password.' }, { status: 400 })
    return new Response('{}', { status: 404 })
  }
  try {
    const request = () => new Request('https://app.tomify.test/api/recovery/recovery-1', { method: 'DELETE', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } })
    const db = torrentDeleteDatabase(torrent, 'downloading')
    const failed = await worker.fetch(request(), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(failed.status, 502)
    assert.match((await failed.json()).message, /torrent could not be removed from qBittorrent/)
    assert.equal(db.deleted.length, 0)
    const usenet = { ...torrent, backend: 'usenet' }
    const blocked = await worker.fetch(request(), { TOMIFY_DB: torrentDeleteDatabase(usenet, 'downloading'), RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(blocked.status, 409)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an importing recovery item cannot be deleted', async () => {
  const candidate = { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, provenanceJson: JSON.stringify({ job: { id: 'job-1', status: 'importing', progress: 100 } }) }
  const db = torrentDeleteDatabase(candidate, 'importing')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    return new Response('{}', { status: 404 })
  }
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1', { method: 'DELETE', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'recovery-job-active')
    assert.equal(db.deleted.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// A recovery item and its one candidate, kept up to date by the UPDATE statements the Worker runs.
function recoveryJobDatabase({ status, candidate }) {
  const item = { id: 'recovery-1', artist: 'They Might Be Giants', title: 'Birdhouse in Your Soul', album: 'Flood', status, error: null, metadataResolutionJson: JSON.stringify({ candidateId: candidate.id, status: 'matched', confidence: 90, strong: false }), artworkResolutionJson: JSON.stringify({ candidateId: candidate.id, candidates: [] }) }
  const columns = { imported_path: 'importedPath', provenance_json: 'provenanceJson', selected_candidate_id: 'selectedCandidateId', playback_json: 'playbackJson' }
  const apply = (sql, args) => {
    const match = sql.match(/^UPDATE (recovery_items|recovery_candidates) SET (.+?) WHERE/)
    if (!match) return
    const row = match[1] === 'recovery_items' ? item : candidate
    let index = 0
    for (const assignment of match[2].split(/,\s*(?=\w+ = )/)) {
      const [column, value] = assignment.split(' = ')
      const key = columns[column] || column
      if (value === '?') row[key] = args[index++]
      else if (value.startsWith('COALESCE(?')) row[key] = args[index++] ?? row[key]
      else if (value.startsWith("'")) row[key] = value.slice(1, -1)
      else if (value === 'NULL') row[key] = null
    }
  }
  const prepare = (sql) => ({
    sql, args: [],
    bind(...args) { this.args = args; return this },
    async first() { return sql.startsWith('SELECT id, artist, title, album') ? { ...item } : null },
    async all() { return { results: sql.includes('FROM recovery_candidates') ? [{ ...candidate }] : [] } },
    async run() { apply(sql, this.args); return {} },
  })
  return { item, candidate, prepare, async batch(statements) { for (const statement of statements) apply(statement.sql, statement.args); return [] } }
}

async function withRecoveryAgent(agent, callback) {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    if (url.pathname.startsWith('/v1/')) { const body = JSON.parse(init.body); requests.push([url.pathname, body]); return agent(url.pathname, body) }
    return new Response('{}', { status: 404 })
  }
  try { await callback(requests) } finally { globalThis.fetch = originalFetch }
}

const recoveryHeaders = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
const youtubeResult = { path: '/recovery/They Might Be Giants/Flood/Birdhouse in Your Soul.m4a', quality: { codec: 'aac', container: 'mp4', bitrate: 256000, sampleRate: 44100, channels: 2, duration: 200 }, provenance: { source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc', archiveStatus: 'lossy-recovery-copy' } }

test('Recovery cancels an active job for any backend, cleans up raced imports, and keeps its candidate', async () => {
  const originalProvenance = { source: 'usenet', searchMode: 'track', raw: { providerId: 'indexer' }, job: { id: 'job-1', status: 'downloading', progress: 40 } }
  const db = recoveryJobDatabase({ status: 'downloading', candidate: { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, url: 'https://indexer.test/details/1', title: 'Flood', channel: 'Indexer', provenanceJson: JSON.stringify(originalProvenance) } })
  await withRecoveryAgent((path) => path === '/v1/jobs/cancel'
    ? Response.json({ cancelled: true, remoteRemoved: true, importedPaths: ['/recovery/raced.flac'] })
    : Response.json({ deleted: ['/recovery/raced.flac'] }), async (requests) => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/cancel', { method: 'POST', headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.item.status, 'candidate-found')
    assert.equal(body.item.candidates.length, 1)
    assert.equal(body.item.candidates[0].selected, true)
    assert.equal(body.item.candidates[0].provenance.job, undefined)
    assert.equal(body.item.candidates[0].provenance.raw.providerId, 'indexer')
    assert.deepEqual(requests, [
      ['/v1/jobs/cancel', { jobId: 'job-1' }],
      ['/v1/delete', { importedPaths: ['/recovery/raced.flac'] }],
    ])
  })
})

test('the Recovery page job poll reads the agent job and updates the item as it downloads and completes', async () => {
  const db = recoveryJobDatabase({ status: 'queued', candidate: { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, url: 'https://indexer.test/details/1', title: 'Flood', channel: 'Indexer', provenanceJson: JSON.stringify({ source: 'usenet', job: { id: 'job-1', status: 'queued', progress: 0 } }) } })
  let answer = { job: { id: 'job-1', status: 'downloading', progress: 40, message: 'Downloading' } }
  await withRecoveryAgent(() => Response.json(answer), async (requests) => {
    const poll = () => worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/job', { headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    const downloading = await poll()
    assert.equal(downloading.status, 200)
    assert.equal((await downloading.json()).item.candidates[0].provenance.job.progress, 40)
    assert.equal(db.item.status, 'downloading')

    answer = { job: { id: 'job-1', status: 'importing', progress: 100 } }
    await poll()
    assert.equal(db.item.status, 'queued')

    answer = { job: { id: 'job-1', status: 'completed', progress: 100, result: { ...youtubeResult, path: '/recovery/They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac', quality: { codec: 'flac' }, provenance: undefined } } }
    const completed = await (await poll()).json()
    assert.equal(db.item.status, 'recovered')
    assert.equal(completed.item.candidates[0].importedPath, '/recovery/They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac')
    assert.equal(completed.item.candidates[0].provenance.source, 'usenet')
    assert.equal(completed.item.candidates[0].provenance.job.status, 'completed')

    // The browser only ever reads the job; the agent's runner does the downloading and importing.
    assert.deepEqual(requests, Array.from({ length: 3 }, () => ['/v1/jobs/status', { jobId: 'job-1' }]))
  })
})

test('the Recovery page job poll reports a failed job and an unreachable agent', async () => {
  const db = recoveryJobDatabase({ status: 'downloading', candidate: { id: 'candidate-1', backend: 'torrent', selected: 1, importedPath: null, url: 'magnet:?xt=urn:btih:abc', title: 'Flood', channel: 'Torrent link', provenanceJson: JSON.stringify({ source: 'torrent', job: { id: 'job-1', status: 'downloading', progress: 10 } }) } })
  let agentUp = true
  await withRecoveryAgent(() => agentUp ? Response.json({ job: { id: 'job-1', status: 'failed', progress: 10, error: 'No seeds.' } }) : Response.json({ error: 'recovery-agent-error', message: 'Invalid Usenet job id.' }, { status: 400 }), async () => {
    const poll = () => worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/job', { headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal((await poll()).status, 200)
    assert.equal(db.item.status, 'failed')
    assert.equal(db.item.error, 'No seeds.')
    agentUp = false
    const failed = await poll()
    assert.equal(failed.status, 502)
    assert.equal((await failed.json()).error, 'recovery-job-poll-failed')
  })
})

test('a YouTube import is queued as an agent job, and an older agent that imports straight away still works', async () => {
  const youtubeCandidate = () => ({ id: 'candidate-1', backend: 'youtube', selected: 1, importedPath: null, url: 'https://www.youtube.com/watch?v=abc', externalId: 'abc', title: 'Birdhouse in Your Soul', channel: 'They Might Be Giants', provenanceJson: JSON.stringify({ raw: null }) })
  const acquire = (db) => worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/acquire', { method: 'POST', headers: recoveryHeaders, body: JSON.stringify({ candidateId: 'candidate-1', confirmedAuthorised: true, rightsBasis: 'uploader-authorised' }) }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })

  const queuedDb = recoveryJobDatabase({ status: 'candidate-found', candidate: youtubeCandidate() })
  await withRecoveryAgent((path) => path === '/v1/acquire' ? Response.json({ job: { id: 'job-1', status: 'queued', progress: 0, provider: 'YouTube', downloader: 'youtube' } }, { status: 202 }) : Response.json({ job: { id: 'job-1', status: 'completed', progress: 100, result: youtubeResult } }), async (requests) => {
    const response = await acquire(queuedDb)
    assert.equal(response.status, 202)
    assert.equal(requests[0][0], '/v1/acquire')
    assert.equal(requests[0][1].background, true)
    assert.equal(requests[0][1].backend, 'youtube')
    assert.equal(queuedDb.item.status, 'queued')
    assert.equal(JSON.parse(queuedDb.candidate.provenanceJson).job.id, 'job-1')
    assert.equal(queuedDb.candidate.importedPath, null)

    const polled = await (await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/job', { headers: recoveryHeaders }), { TOMIFY_DB: queuedDb, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })).json()
    // 256 kbps AAC is transparent lossy, which meets the default preferred quality.
    assert.equal(queuedDb.item.status, 'recovered')
    assert.equal(polled.item.candidates[0].importedPath, youtubeResult.path)
    assert.equal(polled.item.candidates[0].provenance.source, 'youtube')
    assert.equal(polled.item.candidates[0].provenance.archiveStatus, 'lossy-recovery-copy')
  })

  // An agent from before the job runner ignores background and returns the finished import.
  const syncDb = recoveryJobDatabase({ status: 'candidate-found', candidate: youtubeCandidate() })
  await withRecoveryAgent(() => Response.json(youtubeResult), async () => {
    const response = await acquire(syncDb)
    assert.equal(response.status, 200)
    assert.equal(syncDb.item.status, 'recovered')
    assert.equal(syncDb.candidate.importedPath, youtubeResult.path)
  })
})

test('release acquisition sends the cached MusicBrainz tracklist, then links imported tracks and requeues catalogue matches', async () => {
  const db = await sqliteDatabase()
  // sqliteDatabase() applies drizzle/, which creates every table this test uses.
  const releaseId = '11111111-1111-1111-1111-111111111111'
  const releaseGroupId = '22222222-2222-2222-2222-222222222222'
  const tracklist = {
    albumId: 'album-1', releaseId, releaseGroupId, title: 'Flood', artist: 'They Might Be Giants', date: '1990', discCount: 1, source: 'manual',
    tracks: [
      { key: '1-1', disc: 1, number: 1, title: 'Theme from Flood', artist: 'They Might Be Giants', length: 45, recordingId: '31111111-1111-1111-1111-111111111111', isrc: 'USAAA9000001' },
      { key: '1-2', disc: 1, number: 2, title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', length: 190, recordingId: '32222222-2222-2222-2222-222222222222', isrc: 'USAAA9000002' },
    ],
  }
  const metadataResolution = JSON.stringify({ candidateId: 'candidate-1', authority: 'musicbrainz', status: 'matched', confidence: 100, strong: true, metadata: { artist: 'They Might Be Giants', album: 'Flood', releaseId } })
  const artworkResolution = JSON.stringify({ candidateId: 'candidate-1', candidates: [], selectedCandidateId: null })
  db.sqlite.prepare('INSERT INTO recovery_items (id, username, artist, title, album, musicbrainz_id, metadata_resolution_json, artwork_resolution_json, source_json, status, selected_candidate_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('recovery-1', 'tom', 'They Might Be Giants', 'Flood', 'Flood', releaseGroupId, metadataResolution, artworkResolution, JSON.stringify({ albumId: 'album-1', releaseId }), 'candidate-found', 'candidate-1')
  db.sqlite.prepare('INSERT INTO recovery_items (id, username, artist, title, album, musicbrainz_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run('existing-track', 'tom', 'They Might Be Giants', 'Theme from Flood', 'Flood', tracklist.tracks[0].recordingId, 'missing')
  db.sqlite.prepare('INSERT INTO recovery_candidates (id, recovery_id, backend, external_id, url, title, channel, match_score, selected, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('candidate-1', 'recovery-1', 'usenet', 'nzb-1', 'https://indexer.test/details/1', 'They Might Be Giants - Flood', 'Indexer', 100, 1, JSON.stringify({ searchMode: 'release', raw: { searchMode: 'release', providerId: 'indexer' } }))
  db.sqlite.prepare('INSERT INTO release_tracklists (album_id, release_id, release_group_id, source, tracklist_json, editions_json) VALUES (?, ?, ?, ?, ?, ?)').run('album-1', releaseId, releaseGroupId, 'manual', JSON.stringify(tracklist), '[]')
  db.sqlite.prepare('INSERT INTO catalogue_playlists (id, username, name, provider, provider_playlist_id, source_url) VALUES (?, ?, ?, ?, ?, ?)').run('playlist-1', 'tom', 'Flood', 'spotify', 'spotify-1', 'https://open.spotify.com/playlist/spotify-1')
  for (const [index, track] of tracklist.tracks.entries()) db.sqlite.prepare('INSERT INTO catalogue_playlist_items (id, playlist_id, position, metadata_json, status, local_track_id, local_track_json, match_confidence, user_confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`catalogue-${index + 1}`, 'playlist-1', index, JSON.stringify({ title: track.title, album: 'Flood', artists: ['They Might Be Giants'], isrc: track.isrc }), 'available', `old-${index + 1}`, '{}', 100, 1)

  const importedTracks = tracklist.tracks.map((track) => ({
    path: `/recovery/They Might Be Giants/Flood/${String(track.number).padStart(2, '0')} - ${track.title}.flac`, originalPath: `/recovery/They Might Be Giants/Flood/.tomify-source/${track.title}.flac`,
    artist: track.artist, albumArtist: 'They Might Be Giants', album: 'Flood', title: track.title, trackNumber: track.number, discNumber: track.disc,
    quality: { codec: 'flac', container: 'flac', duration: track.length, sampleRate: 44100, channels: 2 },
    provenance: { source: 'usenet', resolvedMetadata: { artist: track.artist, albumArtist: 'They Might Be Giants', album: 'Flood', title: track.title, trackNumber: track.number, discNumber: track.disc, recordingId: track.recordingId, releaseId, releaseGroupId, isrc: track.isrc } },
  }))
  let jobComplete = false
  await withRecoveryAgent((path) => {
    if (path === '/v1/status') return Response.json({ contract: 2 })
    if (path === '/v1/acquire') return Response.json({ job: { id: 'release-job', status: 'queued', progress: 0, provider: 'Indexer', downloader: 'sabnzbd' } }, { status: 202 })
    if (path === '/v1/jobs/status' && jobComplete) return Response.json({ job: { id: 'release-job', status: 'completed', progress: 100, result: { ...importedTracks[0], artist: 'They Might Be Giants', album: 'Flood', importedCount: 2, importedTracks, completeness: { matched: 2, total: 2, missingTracks: [], extraFiles: [] }, extraFiles: [] } } })
    return Response.json({ error: 'unexpected-agent-request' }, { status: 500 })
  }, async (requests) => {
    const acquired = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/acquire', { method: 'POST', headers: recoveryHeaders, body: JSON.stringify({ candidateId: 'candidate-1', confirmedAuthorised: true, rightsBasis: 'uploader-authorised' }) }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(acquired.status, 202)
    const acquireBody = requests.find(([path]) => path === '/v1/acquire')[1]
    assert.deepEqual(acquireBody.tracklist, tracklist)
    jobComplete = true
    const completed = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/job', { headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(completed.status, 200)
  })

  const recoveries = db.sqlite.prepare("SELECT id, title, musicbrainz_id AS recordingId, status FROM recovery_items WHERE username = 'tom' AND title != 'Flood' ORDER BY title").all().map((row) => ({ ...row }))
  assert.equal(recoveries.length, 2)
  assert.equal(recoveries.find((row) => row.title === 'Theme from Flood').id, 'existing-track')
  assert.deepEqual(recoveries.map((row) => [row.title, row.recordingId, row.status]), [
    ['Birdhouse in Your Soul', tracklist.tracks[1].recordingId, 'recovered'],
    ['Theme from Flood', tracklist.tracks[0].recordingId, 'recovered'],
  ])
  const importedCandidates = db.sqlite.prepare("SELECT recovery_id AS recoveryId, imported_path AS importedPath FROM recovery_candidates WHERE recovery_id != 'recovery-1' ORDER BY imported_path").all().map((row) => ({ ...row }))
  assert.equal(importedCandidates.length, 2)
  assert.equal(importedCandidates.every((candidate) => candidate.importedPath.endsWith('.flac')), true)
  const catalogue = db.sqlite.prepare('SELECT status, local_track_id AS localTrackId, local_track_json AS localTrackJson, recovery_id AS recoveryId, match_confidence AS confidence, user_confirmed AS confirmed FROM catalogue_playlist_items ORDER BY position').all().map((row) => ({ ...row }))
  assert.deepEqual(catalogue.map((row) => ({ ...row, hasRecovery: Boolean(row.recoveryId), recoveryId: undefined })), [
    { status: 'missing', localTrackId: null, localTrackJson: null, confidence: 0, confirmed: 0, hasRecovery: true, recoveryId: undefined },
    { status: 'missing', localTrackId: null, localTrackJson: null, confidence: 0, confirmed: 0, hasRecovery: true, recoveryId: undefined },
  ])
})

async function withRebootFetch({ admin, agent }, callback) {
  const originalFetch = globalThis.fetch
  const agentRequests = []
  const navidromeRequests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/rest/')) navidromeRequests.push(url)
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { username: url.searchParams.get('username'), adminRole: admin } } })
    agentRequests.push({ url: url.href, authorization: init?.headers?.authorization, body: JSON.parse(init?.body || '{}') })
    return agent()
  }
  try { await callback(agentRequests, navidromeRequests) } finally { globalThis.fetch = originalFetch }
}

const rebootEnv = { RECOVERY_AGENT_URL: 'https://agent.tomify.test', RECOVERY_AGENT_TOKEN: 'agent-token' }
test('session and administrator checks use NAVIDROME_ORIGIN with their existing API parameters', async () => {
  await withRebootFetch({ admin: true, agent: () => Response.json({ contract: 2 }) }, async (_agentRequests, navidromeRequests) => {
    const headers = { 'x-tomify-user': 'origin-check', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }
    assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/recovery-agent/status', { headers }), rebootEnv)).status, 200)
    assert.deepEqual(navidromeRequests.map((url) => url.origin + url.pathname), [TEST_NAVIDROME_ORIGIN + '/rest/ping.view', TEST_NAVIDROME_ORIGIN + '/rest/getUser.view'])
    assert.equal(navidromeRequests[0].search, '?u=origin-check&t=token&s=salt&v=1.16.1&c=Tomify&f=json')
    assert.equal(navidromeRequests[1].search, '?u=origin-check&t=token&s=salt&v=1.16.1&c=Tomify&f=json&username=origin-check')
  })
})

test('library inventory routes require an administrator and pass all three actions to the agent', async () => {
  await withRebootFetch({ admin: false, agent: () => Response.json({}) }, async (agentRequests) => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/inventory/status', { method: 'POST', headers: recoveryHeaders, body: '{}' }), rebootEnv)
    assert.equal(response.status, 403)
    assert.equal(agentRequests.length, 0)
  })

  await withRebootFetch({ admin: true, agent: () => Response.json({ ok: true }) }, async (agentRequests) => {
    for (const action of ['scan', 'status', 'summary']) {
      const response = await worker.fetch(new Request(`https://app.tomify.test/api/inventory/${action}`, { method: 'POST', headers: recoveryHeaders, body: '{}' }), rebootEnv)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
    }
    assert.deepEqual(agentRequests.map((request) => new URL(request.url).pathname), ['/v1/inventory/scan', '/v1/inventory/status', '/v1/inventory/summary'])
  })

  await withRebootFetch({ admin: true, agent: () => Response.json({ error: 'not-found' }, { status: 404 }) }, async () => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/inventory/summary', { method: 'POST', headers: recoveryHeaders, body: '{}' }), rebootEnv)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'inventory-not-available')
  })
})

test('library move routes require an administrator, proxy to the agent and relink songs in D1 after an apply', async () => {
  const statements = []
  const db = {
    prepare(sql) { return { sql, args: [], bind(...args) { this.args = args; return this } } },
    async batch(list) { statements.push(...list.map((statement) => [statement.sql.split(' ').slice(0, 2).join(' '), ...statement.args])); return [] },
  }
  const env = { ...rebootEnv, TOMIFY_DB: db }
  const post = (action, body) => worker.fetch(new Request(`https://app.tomify.test/api/library-moves/${action}`, { method: 'POST', headers: recoveryHeaders, body: JSON.stringify(body) }), env)
  const journal = { id: '6f1c1f9e-4d1a-4c84-9a8e-111111111111', status: 'applied', moves: [{ from: '/srv/music/B/a.flac', to: '/srv/music/_Duplicates/B/a.flac' }] }
  await withRebootFetch({ admin: false, agent: () => Response.json({}) }, async (agentRequests) => {
    assert.equal((await post('plan', { kind: 'merge' })).status, 403)
    assert.equal(agentRequests.length, 0)
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({ journal, moves: [journal] }) }, async (agentRequests) => {
    const merge = { kind: 'merge', keep: '/srv/music/A/a.flac', paths: ['/srv/music/A/a.flac', '/srv/music/B/a.flac'] }
    for (const action of ['plan', 'list', 'undo']) assert.equal((await post(action, action === 'undo' ? { id: journal.id } : merge)).status, 200)
    assert.deepEqual(statements, [])
    const response = await post('apply', { ...merge, relink: { 'song-b': 'song-a', bad: 7, same: 'same' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).relinked, 1)
    assert.deepEqual(agentRequests.map((request) => new URL(request.url).pathname), ['/v1/library/moves/plan', '/v1/library/moves/list', '/v1/library/moves/undo', '/v1/library/moves/apply'])
    // The relink map stays in the Worker; the agent only sees the move.
    assert.deepEqual(agentRequests[3].body, merge)
    assert.deepEqual(statements, [['UPDATE catalogue_playlist_items', 'song-a', 'song-a', 'song-b'], ['UPDATE recovery_items', 'song-a', 'song-b']])
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({ error: 'recovery-agent-error', message: 'Refusing to move over existing files: /x' }, { status: 400 }) }, async () => {
    const response = await post('apply', { kind: 'merge' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /Refusing to move over existing files/)
    assert.equal(statements.length, 2)
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({ error: 'not-found' }, { status: 404 }) }, async () => {
    const response = await post('list', {})
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'library-moves-not-available')
  })
})

test('Workers Static Assets serves SPA deep links with the intended cache rules while API paths reach the Worker', { timeout: 30000 }, async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')
  const headerRules = await readFile(new URL('../dist/client/_headers', import.meta.url), 'utf8')
  assert.match(config, /directory = "\.\/dist\/client"/)
  assert.match(config, /not_found_handling = "single-page-application"/)
  for (const route of ['/api', '/api/*', '/navidrome', '/navidrome/*']) assert.ok(config.includes(`"${route}"`))
  assert.match(headerRules, /\/index\.html\s+Cache-Control: no-cache/)
  assert.match(headerRules, /\/sw\.js\s+Cache-Control: no-cache/)
  assert.match(headerRules, /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/)

  const index = await readFile(new URL('../dist/client/index.html', import.meta.url), 'utf8')
  const hashedAsset = index.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1]
  assert.ok(hashedAsset)
  // Wrangler 4.86 is the newest Node 20-compatible release. Its older workerd crashes on Windows
  // under Node 24; Linux CI still runs this live integration check under the repository's Node 22.
  if (process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 24) return
  await withStaticAssetsWorker(async (origin) => {
    const deepLink = await fetch(`${origin}/albums/123`, { headers: { accept: 'text/html' } })
    assert.equal(deepLink.status, 200)
    assert.match(await deepLink.text(), /<div id="root"><\/div>/)
    const indexResponse = await fetch(`${origin}/index.html`, { redirect: 'manual' })
    assert.equal(indexResponse.headers.get('cache-control'), 'no-cache')
    const serviceWorkerResponse = await fetch(`${origin}/sw.js`)
    assert.equal(serviceWorkerResponse.headers.get('cache-control'), 'no-cache')
    const hashedResponse = await fetch(`${origin}${hashedAsset}`)
    assert.equal(hashedResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    const api = await fetch(`${origin}/api/does-not-exist`, { headers: { accept: 'text/html' } })
    assert.equal(api.status, 404)
    assert.match(api.headers.get('content-type') || '', /^application\/json/)
    assert.deepEqual(await api.json(), { error: 'not-found' })
    const obsoleteServerAsset = await fetch(`${origin}/server/index.js`)
    assert.match(await obsoleteServerAsset.text(), /<div id="root"><\/div>/)
  })
})

test('library health report requires an administrator and adds D1 imports whose files are absent', async () => {
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...args) { this.args = args; return this },
        async all() {
          if (sql.includes('FROM release_tracklists')) return { results: [{ tracklistJson: JSON.stringify({ albumId: 'album-1', title: 'Flood', artist: 'They Might Be Giants', tracks: [{ disc: 1, number: 1, title: 'Theme' }] }) }] }
          if (sql.includes('FROM library_health_dismissals')) return { results: [] }
          return { results: [
            { id: 'present-item', artist: 'The Kinks', title: 'Waterloo Sunset', album: 'Something Else', importedPath: '/recovery/present.flac' },
            { id: 'missing-item', artist: 'The Kinks', title: 'Days', album: 'Village Green', importedPath: '/recovery/missing.flac', updatedAt: '2026-10-16 11:00:00' },
            { id: 'artist-only-item', artist: 'The Beatles', title: '', album: null, importedPath: '/recovery/The Beatles/Past Masters I/01.flac', updatedAt: '2026-10-16 11:30:00' },
            { id: 'imported-after-scan', artist: 'ELO', title: 'Overture', album: null, importedPath: '/recovery/after.flac', updatedAt: '2026-10-16 12:30:00' },
          ] }
        },
      }
    },
  }
  const env = { ...rebootEnv, TOMIFY_DB: db }
  await withRebootFetch({ admin: false, agent: () => Response.json({}) }, async (agentRequests) => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/inventory/report', { method: 'POST', headers: recoveryHeaders, body: '{}' }), env)
    assert.equal(response.status, 403)
    assert.equal(agentRequests.length, 0)
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({ report: { completedAt: '2026-10-16T12:00:00Z', duplicates: [], partialAlbums: [], orphanedSources: [], shadowedRecovery: [], checkedPaths: { '/recovery/present.flac': true, '/recovery/missing.flac': false, '/recovery/The Beatles/Past Masters I/01.flac': false, '/recovery/after.flac': false } } }) }, async (agentRequests) => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/inventory/report', { method: 'POST', headers: recoveryHeaders, body: '{}' }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    // The ELO import is newer than the scan, so the inventory has not seen it yet; that is not a missing file.
    assert.deepEqual(body.report.missingD1Files, [
      { kind: 'missing-d1-file', label: 'The Kinks — Days', paths: ['/recovery/missing.flac'], recoveryId: 'missing-item' },
      { kind: 'missing-d1-file', label: 'The Beatles — Past Masters I', paths: ['/recovery/The Beatles/Past Masters I/01.flac'], recoveryId: 'artist-only-item' },
    ])
    assert.equal(body.report.checkedPaths, undefined)
    assert.equal(agentRequests[0].body.tracklists[0].albumId, 'album-1')
    assert.deepEqual(agentRequests[0].body.checkPaths, ['/recovery/present.flac', '/recovery/missing.flac', '/recovery/The Beatles/Past Masters I/01.flac', '/recovery/after.flac'])
  })
  // Before the first completed scan the inventory is empty, so nothing can be called missing.
  await withRebootFetch({ admin: true, agent: () => Response.json({ report: { completedAt: null, duplicates: [], partialAlbums: [], orphanedSources: [], shadowedRecovery: [], checkedPaths: { '/recovery/present.flac': false, '/recovery/missing.flac': false } } }) }, async () => {
    const body = await (await worker.fetch(new Request('https://app.tomify.test/api/inventory/report', { method: 'POST', headers: recoveryHeaders, body: '{}' }), env)).json()
    assert.deepEqual(body.report.missingD1Files, [])
  })
})

test('library health findings marked as fine move to the dismissed list until their paths change', async () => {
  const dismissals = new Map()
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...args) { this.args = args; return this },
        async run() {
          if (sql.startsWith('INSERT OR REPLACE INTO library_health_dismissals')) dismissals.set(`${this.args[0]}\0${this.args[1]}`, { category: this.args[0], pathsKey: this.args[1], dismissedBy: this.args[3], createdAt: '2026-10-16 21:30:00' })
          if (sql.startsWith('DELETE FROM library_health_dismissals')) dismissals.delete(`${this.args[0]}\0${this.args[1]}`)
          return {}
        },
        async all() { return { results: sql.includes('FROM library_health_dismissals') ? [...dismissals.values()] : [] } },
      }
    },
  }
  const env = { ...rebootEnv, TOMIFY_DB: db }
  const rammstein = { kind: 'recording', label: 'Rammstein — Rammstein', paths: ['/master/Rammstein/4-04.flac', '/master/Rammstein/3-04.flac'] }
  const nofx = { kind: 'recording', label: 'NOFX — Lower', paths: ['/master/NOFX/1-05.mp3', '/master/NOFX/2-06.mp3'] }
  const agentReport = () => Response.json({ report: { completedAt: '2026-10-16T21:00:00Z', duplicates: [rammstein, nofx], partialAlbums: [], orphanedSources: [], shadowedRecovery: [], checkedPaths: {} } })
  const post = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/inventory/${path}`, { method: 'POST', headers: recoveryHeaders, body: JSON.stringify(body) }), env)
  await withRebootFetch({ admin: false, agent: agentReport }, async () => {
    assert.equal((await post('dismiss', { category: 'duplicates', paths: rammstein.paths })).status, 403)
  })
  await withRebootFetch({ admin: true, agent: agentReport }, async (agentRequests) => {
    assert.equal((await post('dismiss', { category: 'missingD1Files', paths: ['/x'] })).status, 400)
    assert.equal((await post('dismiss', { category: 'duplicates', paths: [] })).status, 400)
    // Paths are matched in any order.
    assert.equal((await post('dismiss', { category: 'duplicates', paths: [...rammstein.paths].reverse(), label: rammstein.label })).status, 200)
    assert.equal(agentRequests.length, 0)
    let report = (await (await post('report', {})).json()).report
    assert.deepEqual(report.duplicates.map((entry) => entry.label), ['NOFX — Lower'])
    assert.deepEqual(report.dismissed.map((entry) => [entry.category, entry.label, entry.dismissedBy]), [['duplicates', 'Rammstein — Rammstein', 'tom']])
    assert.equal((await post('dismiss', { category: 'duplicates', paths: rammstein.paths, restore: true })).status, 200)
    report = (await (await post('report', {})).json()).report
    assert.equal(report.duplicates.length, 2)
    assert.deepEqual(report.dismissed, [])
  })
})

const rebootRequest = (body) => new Request('https://app.tomify.test/api/system/reboot', { method: 'POST', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('Media server reboot requires a signed-in Navidrome administrator', async () => {
  const unauthenticated = await worker.fetch(new Request('https://app.tomify.test/api/system/reboot', { method: 'POST', body: '{"confirm":"reboot"}' }), rebootEnv)
  assert.equal(unauthenticated.status, 401)
  await withRebootFetch({ admin: false, agent: () => Response.json({ rebooting: true }, { status: 202 }) }, async (agentRequests) => {
    const response = await worker.fetch(rebootRequest({ confirm: 'reboot' }), rebootEnv)
    assert.equal(response.status, 403)
    assert.match((await response.json()).message, /Navidrome administrator/)
    assert.equal(agentRequests.length, 0)
  })
})

test('Media server reboot requires confirmation and forwards it to the agent', async () => {
  await withRebootFetch({ admin: true, agent: () => Response.json({ rebooting: true, scheduledAt: '2026-10-15T12:00:03.000Z' }, { status: 202 }) }, async (agentRequests) => {
    const unconfirmed = await worker.fetch(rebootRequest({}), rebootEnv)
    assert.equal(unconfirmed.status, 400)
    assert.equal(agentRequests.length, 0)

    const response = await worker.fetch(rebootRequest({ confirm: 'reboot' }), rebootEnv)
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { rebooting: true, scheduledAt: '2026-10-15T12:00:03.000Z' })
    assert.deepEqual(agentRequests, [{ url: 'https://agent.tomify.test/v1/system/reboot', authorization: 'Bearer agent-token', body: { confirm: 'reboot' } }])
  })
})

test('Media server reboot reports an agent that has reboot disabled', async () => {
  await withRebootFetch({ admin: true, agent: () => Response.json({ error: 'recovery-agent-error', message: 'Remote reboot is disabled on this server.' }, { status: 400 }) }, async () => {
    const response = await worker.fetch(rebootRequest({ confirm: 'reboot' }), rebootEnv)
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /Remote reboot is disabled/)
  })
})

const vpnRequest = (method, body) => new Request('https://app.tomify.test/api/system/vpn', { method, headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })

test('VPN status and changes require a signed-in Navidrome administrator', async () => {
  const unauthenticated = await worker.fetch(new Request('https://app.tomify.test/api/system/vpn'), rebootEnv)
  assert.equal(unauthenticated.status, 401)
  await withRebootFetch({ admin: false, agent: () => Response.json({ state: 'connected' }) }, async (agentRequests) => {
    for (const request of [vpnRequest('GET'), vpnRequest('POST', { action: 'disconnect' })]) {
      const response = await worker.fetch(request, rebootEnv)
      assert.equal(response.status, 403)
      assert.match((await response.json()).message, /Navidrome administrator/)
    }
    assert.equal(agentRequests.length, 0)
  })
})

test('VPN status and changes are forwarded to the agent, and only connect or disconnect is accepted', async () => {
  await withRebootFetch({ admin: true, agent: () => Response.json({ control: 'enabled', state: 'connected', country: 'United Kingdom' }) }, async (agentRequests) => {
    const status = await worker.fetch(vpnRequest('GET'), rebootEnv)
    assert.equal(status.status, 200)
    assert.equal((await status.json()).country, 'United Kingdom')

    const invalid = await worker.fetch(vpnRequest('POST', { action: 'connect Germany' }), rebootEnv)
    assert.equal(invalid.status, 400)

    const changed = await worker.fetch(vpnRequest('POST', { action: 'disconnect', target: 'Germany' }), rebootEnv)
    assert.equal(changed.status, 200)
    assert.deepEqual(agentRequests, [
      { url: 'https://agent.tomify.test/v1/system/vpn/status', authorization: 'Bearer agent-token', body: {} },
      { url: 'https://agent.tomify.test/v1/system/vpn', authorization: 'Bearer agent-token', body: { action: 'disconnect' } },
    ])
  })
})

test('VPN changes report a refusal from the agent', async () => {
  await withRebootFetch({ admin: true, agent: () => Response.json({ error: 'recovery-agent-error', message: 'NordVPN\'s kill switch is not off.' }, { status: 400 }) }, async () => {
    const response = await worker.fetch(vpnRequest('POST', { action: 'connect' }), rebootEnv)
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /kill switch/)
  })
})

// A D1-shaped wrapper over node:sqlite so playlist sharing runs against real SQL.
const adminHeaders = { 'x-tomify-user': 'guest', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' }
const recoveryCall = (path, method, body) => worker.fetch(new Request('https://app.tomify.test' + path, { method, headers: adminHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }), { ...rebootEnv, TOMIFY_DB: wantedMusicDatabase() })

test('Recovery routes require a signed-in Navidrome administrator', async () => {
  const unauthenticated = await worker.fetch(new Request('https://app.tomify.test/api/recovery'), { ...rebootEnv, TOMIFY_DB: wantedMusicDatabase() })
  assert.equal(unauthenticated.status, 401)
  await withRebootFetch({ admin: false, agent: () => Response.json({ backends: [] }) }, async (agentRequests) => {
    for (const [path, method, body] of [['/api/recovery', 'GET'], ['/api/recovery', 'POST', { artist: 'They Might Be Giants', album: 'Flood' }], ['/api/recovery/recovery-1/search', 'POST', { backend: 'usenet' }], ['/api/recovery/recovery-1/job', 'GET'], ['/api/recovery/recovery-1/cancel', 'POST'], ['/api/recovery/recovery-1', 'DELETE']]) {
      const response = await recoveryCall(path, method, body)
      assert.equal(response.status, 403, `${method} ${path}`)
      assert.match((await response.json()).message, /Navidrome administrator/)
    }
    assert.equal(agentRequests.length, 0)
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({ backends: [] }) }, async () => {
    assert.equal((await recoveryCall('/api/recovery', 'GET')).status, 200)
  })
})

test('only administrators can add album or playlist tracks to Recovery', async () => {
  await withRebootFetch({ admin: false, agent: () => Response.json({}) }, async () => {
    const env = { TOMIFY_DB: completenessDatabase() }
    const completeness = await worker.fetch(new Request('https://app.tomify.test/api/album-completeness/recovery', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ albumId: 'album-1', trackKeys: ['1-1'] }) }), env)
    assert.equal(completeness.status, 403)
    assert.equal(env.TOMIFY_DB.recoveryItems.length, 0)
    const db = await sqliteDatabase()
    for (const [path, method] of [['/api/catalogue-playlists', 'POST'], ['/api/catalogue-playlists/playlist-1', 'PUT']]) {
      const response = await worker.fetch(new Request('https://app.tomify.test' + path, { method, headers: adminHeaders, body: JSON.stringify({ playlist: { name: 'Mix', items: [] }, createRecovery: true }) }), { TOMIFY_DB: db })
      assert.equal(response.status, 403, `${method} ${path}`)
      assert.match((await response.json()).message, /Import the playlist without Recovery/)
    }
  })
})

// An in-memory D1 stand-in with every drizzle/ migration applied, as `wrangler d1 migrations apply` would.
async function sqliteDatabase() {
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(':memory:')
  const migrations = new URL('../drizzle/', import.meta.url)
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL(name, migrations), 'utf8'))
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    async first() { return sqlite.prepare(sql).get(...args) ?? null },
    async all() { return { results: sqlite.prepare(sql).all(...args) } },
    async run() { sqlite.prepare(sql).run(...args); return {} },
  })
  return { sqlite, prepare: (sql) => statement(sql), async batch(statements) { for (const item of statements) await item.run(); return [] } }
}

async function withNavidromePlaylists(playlists, callback) {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/rest/')) {
      assert.equal(url.origin, TEST_NAVIDROME_ORIGIN)
      requests.push(url)
    }
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.pathname === '/rest/getPlaylist.view') { const playlist = playlists[url.searchParams.get('id')]; return Response.json({ 'subsonic-response': playlist ? { status: 'ok', playlist } : { status: 'failed', error: { code: 70, message: 'playlist not found' } } }) }
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
  try { await callback(requests) } finally { globalThis.fetch = originalFetch }
}

const shareCall = (env, user, path, init = {}) => worker.fetch(new Request('https://app.tomify.test' + path, { ...init, headers: { 'x-tomify-user': user, 'x-tomify-token': 'token-' + user, 'x-tomify-salt': 'salt', 'content-type': 'application/json' } }), env)

test('playlists stay with their owner until shared, and recipients get read-only access', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  await withNavidromePlaylists({ 'nav-1': { id: 'nav-1', name: 'Road trip', owner: 'Tom' } }, async (requests) => {
    for (const user of ['Tom', 'anna', 'sam']) assert.equal((await shareCall(env, user, '/api/playlist-shares')).status, 200)
    assert.equal((await shareCall(env, 'Tom', '/api/catalogue-playlists')).status, 200)
    db.sqlite.prepare("INSERT INTO catalogue_playlists (id, username, name, provider, provider_playlist_id, source_url) VALUES ('imp-1', 'Tom', 'Spotify mix', 'spotify', 'sp1', 'https://open.spotify.com/playlist/sp1')").run()

    assert.equal((await shareCall(env, 'anna', '/api/catalogue-playlists/imp-1')).status, 404)
    assert.equal((await shareCall(env, 'anna', '/api/playlist-shares/imported/imp-1', { method: 'PUT', body: JSON.stringify({ users: ['anna'] }) })).status, 404)
    assert.equal((await shareCall(env, 'anna', '/api/playlist-shares/navidrome/nav-1', { method: 'PUT', body: JSON.stringify({ users: ['anna'] }) })).status, 404)

    const imported = await shareCall(env, 'Tom', '/api/playlist-shares/imported/imp-1', { method: 'PUT', body: JSON.stringify({ users: ['Anna', 'tom', 'stranger'] }) })
    assert.deepEqual(await imported.json(), { kind: 'imported', playlistId: 'imp-1', sharedWith: ['anna'], editors: [] })
    const navidrome = await shareCall(env, 'Tom', '/api/playlist-shares/navidrome/nav-1', { method: 'PUT', body: JSON.stringify({ users: ['anna', 'sam'] }) })
    assert.deepEqual((await navidrome.json()).sharedWith, ['anna', 'sam'])
    const ownerLookup = requests.find((url) => url.pathname === '/rest/getPlaylist.view' && url.searchParams.get('u') === 'Tom')
    assert.equal(ownerLookup.href, TEST_NAVIDROME_ORIGIN + '/rest/getPlaylist.view?u=Tom&t=token-Tom&s=salt&v=1.16.1&c=Tomify&f=json&id=nav-1')

    const tom = await (await shareCall(env, 'Tom', '/api/playlist-shares')).json()
    assert.deepEqual(tom.accounts, ['anna', 'sam'])
    assert.deepEqual(tom.sharedByMe, [{ kind: 'imported', playlistId: 'imp-1', sharedWith: ['anna'], editors: [] }, { kind: 'navidrome', playlistId: 'nav-1', sharedWith: ['anna', 'sam'], editors: [] }])
    const anna = await (await shareCall(env, 'anna', '/api/playlist-shares')).json()
    assert.deepEqual(anna.sharedWithMe, [{ kind: 'navidrome', playlistId: 'nav-1', owner: 'tom', name: 'Road trip', canEdit: false }, { kind: 'imported', playlistId: 'imp-1', owner: 'tom', name: 'Spotify mix', canEdit: false }])

    const detail = await shareCall(env, 'anna', '/api/catalogue-playlists/imp-1')
    assert.equal(detail.status, 200)
    const shared = (await detail.json()).playlist
    assert.equal(shared.name, 'Spotify mix'); assert.equal(shared.owner, 'Tom'); assert.equal(shared.sharedWithMe, true)
    assert.equal((await shareCall(env, 'sam', '/api/catalogue-playlists/imp-1')).status, 404)
    assert.equal((await shareCall(env, 'anna', '/api/catalogue-playlists/imp-1/resolve', { method: 'PATCH', body: JSON.stringify({ items: [] }) })).status, 404)

    await shareCall(env, 'Tom', '/api/playlist-shares/imported/imp-1', { method: 'PUT', body: JSON.stringify({ users: [] }) })
    assert.equal((await shareCall(env, 'anna', '/api/catalogue-playlists/imp-1')).status, 404)
  })
})

test('resolving an imported playlist can return a stale match to missing', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
  try {
    assert.equal((await shareCall(env, 'Tom', '/api/catalogue-playlists')).status, 200)
    db.sqlite.prepare("INSERT INTO catalogue_playlists (id, username, name, provider, provider_playlist_id, source_url) VALUES ('imp-1', 'Tom', 'Spotify mix', 'spotify', 'sp1', 'https://open.spotify.com/playlist/sp1')").run()
    const insert = db.sqlite.prepare("INSERT INTO catalogue_playlist_items (id, playlist_id, position, metadata_json, status, local_track_id, local_track_json, match_confidence) VALUES (?, 'imp-1', ?, ?, ?, ?, ?, ?)")
    insert.run('stale', 0, JSON.stringify({ title: 'Gone', artists: ['A'] }), 'available', 'old-id', JSON.stringify({ id: 'old-id', title: 'Gone' }), 98)
    insert.run('moved', 1, JSON.stringify({ title: 'Moved', artists: ['B'] }), 'available', 'old-2', JSON.stringify({ id: 'old-2', title: 'Moved' }), 98)
    insert.run('pending', 2, JSON.stringify({ title: 'Pending', artists: ['C'] }), 'review', null, null, 80)
    const response = await shareCall(env, 'Tom', '/api/catalogue-playlists/imp-1/resolve', { method: 'PATCH', body: JSON.stringify({ items: [{ id: 'stale', missing: true }, { id: 'moved', localTrack: { id: 'new-2', title: 'Moved' }, matchConfidence: 97 }, { id: 'pending', missing: true }] }) })
    assert.equal(response.status, 200)
    const rows = db.sqlite.prepare("SELECT id, status, local_track_id AS localTrackId, match_confidence AS confidence FROM catalogue_playlist_items WHERE playlist_id = 'imp-1' ORDER BY position").all().map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      { id: 'stale', status: 'missing', localTrackId: null, confidence: 0 },
      { id: 'moved', status: 'available', localTrackId: 'new-2', confidence: 97 },
      { id: 'pending', status: 'review', localTrackId: null, confidence: 80 },
    ], 'only available entries can be returned to missing')
  } finally { globalThis.fetch = originalFetch }
})

test('only administrators can edit release metadata, change album artwork or run the completeness check', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const call = (path, method, body) => worker.fetch(new Request('https://app.tomify.test' + path, { method, headers: adminHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }), env)
  const album = { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' }
  await withRebootFetch({ admin: false, agent: () => Response.json({}, { status: 500 }) }, async (outbound) => {
    assert.equal((await call('/api/album-artwork', 'GET')).status, 200)
    assert.equal((await call('/api/release-meta', 'GET')).status, 200)
    db.sqlite.prepare("INSERT INTO release_metadata (album_id, release_type, source) VALUES ('album-1', 'album', 'musicbrainz')").run()
    // Opening an album that is already classified still works for everyone.
    assert.equal((await (await call('/api/release-meta/enrich', 'POST', album)).json()).cached, true)
    for (const [path, method, body] of [
      ['/api/release-meta/album-1', 'PUT', { releaseType: 'single' }],
      ['/api/release-meta/enrich', 'POST', { ...album, force: true, replaceManual: true }],
      ['/api/album-artwork/lookup', 'POST', album],
      ['/api/album-artwork/select', 'POST', { albumId: 'album-1', provider: 'library' }],
      ['/api/album-artwork/reset', 'POST', { albumId: 'album-1' }],
      ['/api/album-artwork/upload', 'POST', { albumId: 'album-1', image: 'data:image/jpeg;base64,/9j/4A==' }],
      ['/api/album-completeness/tracklist', 'POST', { ...album, localTrackCount: 1 }],
    ]) {
      const response = await call(path, method, body)
      assert.equal(response.status, 403, `${method} ${path}`)
      assert.match((await response.json()).message, /Navidrome administrator/)
    }
    assert.equal(db.sqlite.prepare("SELECT release_type FROM release_metadata WHERE album_id = 'album-1'").get().release_type, 'album')
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM album_artwork').get().count, 0)
    // Nothing reached MusicBrainz or the artwork catalogues.
    assert.equal(outbound.length, 0)
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({}, { status: 500 }) }, async () => {
    assert.equal((await call('/api/release-meta/album-1', 'PUT', { releaseType: 'single' })).status, 200)
    assert.equal((await call('/api/album-artwork/select', 'POST', { albumId: 'album-1', provider: 'library' })).status, 200)
  })
})

test('administrators can upload album artwork from their device, served publicly and removed when replaced', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const call = (path, body) => worker.fetch(new Request('https://app.tomify.test/api/album-artwork/' + path, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) }), env)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])
  await withRebootFetch({ admin: true, agent: () => Response.json({}, { status: 500 }) }, async () => {
    const rejected = await call('upload', { albumId: 'album-1', image: 'data:image/jpeg;base64,' + Buffer.from('<html>').toString('base64') })
    assert.equal(rejected.status, 400)

    const uploaded = await call('upload', { albumId: 'album-1', image: 'data:image/jpeg;base64,' + jpeg.toString('base64'), width: 1200, height: 1200 })
    assert.equal(uploaded.status, 201)
    const { item } = await uploaded.json()
    assert.equal(item.provider, 'upload')
    assert.equal(item.source, 'manual')
    assert.match(item.url, /^\/api\/album-artwork\/image\/[0-9a-f-]{36}$/)

    // Served without Tomify headers, since <img> cannot send them.
    const image = await worker.fetch(new Request('https://app.tomify.test' + item.url), env)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg)

    // A second upload replaces the first, and choosing library artwork removes the upload.
    const second = await (await call('upload', { albumId: 'album-1', image: 'data:image/jpeg;base64,' + jpeg.toString('base64') })).json()
    assert.equal((await worker.fetch(new Request('https://app.tomify.test' + item.url), env)).status, 404)
    assert.equal((await call('select', { albumId: 'album-1', provider: 'library' })).status, 200)
    assert.equal((await worker.fetch(new Request('https://app.tomify.test' + second.item.url), env)).status, 404)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM album_artwork_uploads').get().count, 0)
  })
})

const liveCall = (env, path, init = {}) => worker.fetch(new Request('https://app.tomify.test' + path, { ...init, headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt', 'content-type': 'application/json' } }), env)
const liveState = (deviceId, extra = {}) => ({ deviceId, deviceName: deviceId, queue: [{ id: 't1', title: 'Ana Ng' }], currentIndex: 0, playing: true, currentTime: 12, duration: 200, ...extra })

test('live playback lists open devices, keeps quick commands and lets any open device take over', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  await withNavidromePlaylists({}, async () => {
    const empty = await (await liveCall(env, '/api/live-playback?deviceId=phone&deviceName=iPhone%20app')).json()
    assert.equal(empty.state, null)
    assert.equal(typeof empty.now, 'number')
    assert.deepEqual(empty.devices.map((device) => device.deviceName), ['iPhone app'])

    assert.equal((await liveCall(env, '/api/live-playback', { method: 'POST', body: JSON.stringify(liveState('desktop')) })).status, 200)
    assert.equal((await liveCall(env, '/api/live-playback', { method: 'POST', body: JSON.stringify(liveState('phone')) })).status, 409)

    for (const action of ['next', 'next']) assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'desktop', action }) })).status, 200)
    const queued = await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'desktop', action: 'add-to-queue', track: { id: 't2', title: 'Purple Toupee', secret: 'dropped' } }) })
    assert.equal(queued.status, 200)
    const polled = await (await liveCall(env, '/api/live-playback?deviceId=phone')).json()
    assert.deepEqual(polled.commands.map((command) => [command.revision, command.action]), [[1, 'next'], [2, 'next'], [3, 'add-to-queue']])
    assert.equal(polled.commands[2].track.secret, undefined)
    assert.equal(polled.command.revision, 3)
    assert.deepEqual(polled.devices.map((device) => device.deviceId).sort(), ['desktop', 'phone'])

    assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'laptop', action: 'transfer' }) })).status, 409)
    assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'phone', action: 'pause' }) })).status, 409)
    const transfer = await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'phone', action: 'transfer' }) })
    assert.equal(transfer.status, 200)
  })
})

test('play next from another device carries the songs, cleaned, and refuses an empty list', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  await withNavidromePlaylists({}, async () => {
    await liveCall(env, '/api/live-playback', { method: 'POST', body: JSON.stringify(liveState('desktop')) })
    const tracks = [{ id: 'a', title: 'Alpha', secret: 'dropped' }, { id: 'b', title: 'Bravo' }]
    assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'desktop', action: 'play-next', tracks }) })).status, 200)
    assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'desktop', action: 'play-next', tracks: [] }) })).status, 400)
    assert.equal((await liveCall(env, '/api/live-playback/command', { method: 'POST', body: JSON.stringify({ targetDeviceId: 'desktop', action: 'play-next', tracks: [{ title: 'no id' }] }) })).status, 400)
    const polled = await (await liveCall(env, '/api/live-playback?deviceId=phone')).json()
    const command = polled.commands.at(-1)
    assert.equal(command.action, 'play-next')
    assert.deepEqual(command.tracks.map((track) => track.id), ['a', 'b'])
    assert.equal(command.tracks[0].secret, undefined)
  })
})

test('a closing tab leaves the device list and shows its playback as paused', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  await withNavidromePlaylists({}, async () => {
    await liveCall(env, '/api/live-playback', { method: 'POST', body: JSON.stringify(liveState('desktop')) })
    assert.equal((await liveCall(env, '/api/live-playback/leave', { method: 'POST', body: JSON.stringify({ deviceId: 'desktop', currentTime: 61 }) })).status, 200)
    const after = await (await liveCall(env, '/api/live-playback')).json()
    assert.equal(after.state.playing, false)
    assert.equal(after.state.currentTime, 61)
    assert.equal(after.state.revision, 2)
    assert.deepEqual(after.devices, [])
  })
})

test('live playback reads the single command stored by the previous Worker', async () => {
  assert.deepEqual(parseLiveCommands({ commandJson: JSON.stringify({ action: 'pause' }), commandRevision: 4, commandTargetDevice: 'desktop', commandUpdatedAt: 99 }), [{ action: 'pause', revision: 4, targetDeviceId: 'desktop', updatedAt: 99 }])
  assert.deepEqual(parseLiveCommands({ commandJson: 'not json' }), [])
})

function qualityDatabase({ target = null, items = [], candidates = [] } = {}) {
  const settings = new Map(target ? [['quality_target', target]] : [])
  const statusUpdates = []
  const statement = (sql) => ({
    sql, args: [],
    bind(...args) { this.args = args; return this },
    async first() {
      if (sql.includes('FROM tomify_settings')) return settings.has('quality_target') ? { value: settings.get('quality_target') } : null
      if (sql.startsWith('SELECT id, artist, title, album')) return items.find((item) => item.id === this.args[1]) || null
      return null
    },
    async all() {
      if (sql.includes('FROM recovery_items i LEFT JOIN recovery_candidates')) return { results: items.filter((item) => ['recovered', 'needs-upgrade'].includes(item.status)).map((item) => { const candidate = candidates.find((value) => value.recoveryId === item.id && value.selected) || {}; return { id: item.id, status: item.status, codec: candidate.codec ?? null, container: candidate.container ?? null, bitrate: candidate.bitrate ?? null, provenanceJson: candidate.provenanceJson ?? null } }) }
      if (sql.includes('FROM recovery_candidates')) return { results: candidates.filter((value) => value.recoveryId === this.args[0]) }
      return { results: [] }
    },
    async run() {
      if (sql.startsWith('INSERT INTO tomify_settings')) settings.set('quality_target', this.args[0])
      return {}
    },
  })
  const apply = (value) => {
    if (!value.sql.startsWith('UPDATE recovery_items SET') || !value.sql.includes('status = ?')) return
    const [status, id] = value.sql.includes('selected_candidate_id = ?') ? [value.args[1], value.args[2]] : [value.args[0], value.args[1]]
    statusUpdates.push({ id, status })
    const item = items.find((row) => row.id === id)
    if (item) item.status = status
  }
  return { settings, statusUpdates, prepare: statement, async batch(statements) { statements.forEach(apply); return [] } }
}

const qualityCall = (env, path, method = 'GET', body) => worker.fetch(new Request('https://app.tomify.test' + path, { method, headers: adminHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }), env)

test('the quality target is an administrator-only setting that defaults to transparent-lossy', async () => {
  const env = { TOMIFY_DB: qualityDatabase() }
  assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/settings/quality'), env)).status, 401)
  await withRebootFetch({ admin: false, agent: () => Response.json({}) }, async () => {
    for (const [path, method, body] of [['/api/settings/quality', 'GET'], ['/api/settings/quality', 'PUT', { target: 'lossy' }], ['/api/settings/quality/recheck', 'POST']]) {
      const response = await qualityCall(env, path, method, body)
      assert.equal(response.status, 403, `${method} ${path}`)
      assert.match((await response.json()).message, /Navidrome administrator/)
    }
  })
  await withRebootFetch({ admin: true, agent: () => Response.json({}) }, async () => {
    const initial = await (await qualityCall(env, '/api/settings/quality')).json()
    assert.equal(initial.target, 'transparent-lossy')
    assert.deepEqual(initial.targets.map((option) => option.id), ['lossless', 'transparent-lossy', 'lossy'])
    assert.equal((await qualityCall(env, '/api/settings/quality', 'PUT', { target: 'best' })).status, 400)
    assert.equal((await (await qualityCall(env, '/api/settings/quality', 'PUT', { target: 'lossless' })).json()).target, 'lossless')
    assert.equal(env.TOMIFY_DB.settings.get('quality_target'), 'lossless')
    assert.equal((await (await qualityCall(env, '/api/settings/quality')).json()).target, 'lossless')
  })
})

test('a completed recovery job is marked recovered or needs-upgrade against the saved quality target', async () => {
  const expected = { lossless: 'needs-upgrade', 'transparent-lossy': 'recovered', lossy: 'recovered' }
  for (const [target, status] of Object.entries(expected)) {
    const items = [{ id: 'recovery-1', artist: 'They Might Be Giants', title: 'Birdhouse in Your Soul', status: 'downloading' }]
    const candidates = [{ id: 'candidate-1', recoveryId: 'recovery-1', backend: 'usenet', selected: 1, provenanceJson: JSON.stringify({ source: 'usenet', job: { id: 'job-1', status: 'downloading', progress: 50 } }) }]
    const env = { ...rebootEnv, TOMIFY_DB: qualityDatabase({ target, items, candidates }) }
    const agent = () => Response.json({ job: { id: 'job-1', status: 'completed', progress: 100, result: { importedCount: 1, quality: { codec: 'mp3', container: 'mp3', bitrate: 243_000 }, provenance: { source: 'usenet' } } } })
    await withRebootFetch({ admin: true, agent }, async () => {
      assert.equal((await qualityCall(env, '/api/recovery/recovery-1/job')).status, 200)
    })
    assert.deepEqual(env.TOMIFY_DB.statusUpdates, [{ id: 'recovery-1', status }], `target ${target}`)
  }
})

test('re-checking quality labels recomputes recovered and needs-upgrade items from their stored source quality', async () => {
  const items = [
    { id: 'mp3-v0', status: 'needs-upgrade' }, { id: 'aac-128', status: 'recovered' }, { id: 'flac', status: 'recovered' },
    { id: 'opus-source', status: 'needs-upgrade' }, { id: 'still-missing', status: 'missing' },
  ]
  const candidates = [
    { recoveryId: 'mp3-v0', selected: 1, codec: 'mp3', bitrate: 243_000 },
    { recoveryId: 'aac-128', selected: 1, codec: 'aac', bitrate: 128_000 },
    { recoveryId: 'flac', selected: 1, codec: 'flac', bitrate: 900_000 },
    { recoveryId: 'opus-source', selected: 1, codec: 'opus', bitrate: null, provenanceJson: JSON.stringify({ sourceAudio: { quality: { codec: 'opus', bitrate: 160_000 } } }) },
  ]
  const env = { TOMIFY_DB: qualityDatabase({ items, candidates }) }
  await withRebootFetch({ admin: true, agent: () => Response.json({}) }, async () => {
    const response = await qualityCall(env, '/api/settings/quality/recheck', 'POST')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { target: 'transparent-lossy', checked: 4, changed: 3, recovered: 2, needsUpgrade: 1 })
  })
  assert.deepEqual(Object.fromEntries(items.map((item) => [item.id, item.status])), { 'mp3-v0': 'recovered', 'aac-128': 'needs-upgrade', flac: 'recovered', 'opus-source': 'recovered', 'still-missing': 'missing' })
})

// A stub Navidrome for the library scan after an import: getScanStatus, startScan and search3, plus the agent's job status.
async function withLibraryScanStubs({ scanning = () => false, songs = () => [], job }, callback) {
  const calls = { startScan: 0, search3: [], getScanStatus: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } })
    if (url.pathname.startsWith('/rest/')) assert.equal(url.origin, TEST_NAVIDROME_ORIGIN)
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return ok({ user: { adminRole: true } })
    if (url.pathname === '/rest/getScanStatus.view') { calls.getScanStatus += 1; return ok({ scanStatus: { scanning: scanning() } }) }
    if (url.pathname === '/rest/startScan.view') { calls.startScan += 1; calls.fullScan = url.searchParams.get('fullScan'); return ok({ scanStatus: { scanning: true } }) }
    if (url.pathname === '/rest/search3.view') { calls.search3.push(url.searchParams.get('query')); return ok({ searchResult3: { song: songs(calls.search3.length) } }) }
    if (url.pathname === '/v1/jobs/status') return Response.json({ job })
    return new Response('{}', { status: 404 })
  }
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-16T12:00:00Z') })
  try { await callback(calls) } finally { mock.timers.reset(); globalThis.fetch = originalFetch }
}

const importedFlac = '/recovery/They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac'
const completedJob = { id: 'job-1', status: 'completed', progress: 100, result: { path: importedFlac, quality: { codec: 'flac' } } }
const queuedUsenetItem = () => recoveryJobDatabase({ status: 'queued', candidate: { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, url: 'https://indexer.test/details/1', title: 'Flood', channel: 'Indexer', provenanceJson: JSON.stringify({ source: 'usenet', job: { id: 'job-1', status: 'queued', progress: 0 } }) } })
const recoveryPost = (db, path) => worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1' + path, { method: path === '/job' ? 'GET' : 'POST', headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })

test('a completed import waits for the library scan and becomes ready to play once Navidrome returns the track', async () => {
  const db = queuedUsenetItem()
  const birdhouse = (id, path) => ({ id, title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', path })
  // Navidrome finds nothing for the first two checks; then the scanned copy appears beside an older same-named track.
  const songs = (searches) => searches <= 4 ? [] : [birdhouse('song-old', 'Masters/They Might Be Giants/Flood/02 Birdhouse in Your Soul.mp3'), birdhouse('song-new', 'They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac')]
  await withLibraryScanStubs({ songs, job: completedJob }, async (calls) => {
    const completed = await (await recoveryPost(db, '/job')).json()
    assert.equal(db.item.status, 'recovered', 'the Recovered status is kept')
    assert.equal(completed.item.playback.state, 'scan-pending')
    assert.equal(calls.startScan, 1)
    assert.equal(calls.fullScan, null, 'a quick scan, not a full one')

    const first = await (await recoveryPost(db, '/playback')).json()
    assert.equal(first.item.playback.state, 'scan-pending')
    assert.deepEqual(calls.search3, ['They Might Be Giants Birdhouse in Your Soul', 'Birdhouse in Your Soul'])

    // A second check within 15 s does not ask Navidrome again.
    await recoveryPost(db, '/playback')
    assert.equal(calls.search3.length, 2)

    mock.timers.tick(15_000)
    assert.equal((await (await recoveryPost(db, '/playback')).json()).item.playback.state, 'scan-pending')
    mock.timers.tick(15_000)
    const ready = await (await recoveryPost(db, '/playback')).json()
    assert.equal(ready.item.playback.state, 'ready')
    assert.equal(ready.item.playback.songId, 'song-new')
    assert.equal(ready.item.status, 'recovered')
    assert.equal(calls.startScan, 1, 'the scan started at import was enough')

    // Polling the finished job again keeps the ready state.
    await recoveryPost(db, '/job')
    assert.equal(JSON.parse(db.item.playbackJson).state, 'ready')
  })
})

test('a track still missing ten minutes after the import is marked not found, and retry starts another scan', async () => {
  const db = queuedUsenetItem()
  let scanning = true
  await withLibraryScanStubs({ scanning: () => scanning, job: completedJob }, async (calls) => {
    await recoveryPost(db, '/job')
    assert.equal(calls.startScan, 0, 'a running scan is not interrupted by a new one')
    scanning = false
    await recoveryPost(db, '/playback')
    assert.equal(calls.startScan, 1, 'a scan that was already running may have missed the file, so one is started afterwards')
    mock.timers.tick(9 * 60_000)
    assert.equal((await (await recoveryPost(db, '/playback')).json()).item.playback.state, 'scan-pending')
    mock.timers.tick(60_000)
    const failed = await (await recoveryPost(db, '/playback')).json()
    assert.equal(failed.item.playback.state, 'scan-failed')
    assert.equal(failed.item.status, 'recovered')

    const retried = await (await recoveryPost(db, '/playback/retry')).json()
    assert.equal(retried.item.playback.state, 'scan-pending')
    assert.equal(retried.item.playback.since, '2026-10-16T12:10:00.000Z')
    assert.equal(calls.startScan, 2)
  })
})

test('the library check route refuses items that were never imported', async () => {
  const db = recoveryJobDatabase({ status: 'candidate-found', candidate: { id: 'candidate-1', backend: 'youtube', selected: 1, importedPath: null, url: 'https://www.youtube.com/watch?v=abc', title: 'Birdhouse', channel: 'TMBG', provenanceJson: '{}' } })
  await withLibraryScanStubs({ job: completedJob }, async () => {
    assert.equal((await recoveryPost(db, '/playback/retry')).status, 409)
    assert.equal((await (await recoveryPost(db, '/playback')).json()).item.playback, null)
  })
})

test('a database without a migrated table gets schema-out-of-date instead of the Worker creating it', async () => {
  const statements = []
  const missingTable = {
    prepare(sql) {
      statements.push(sql)
      const fail = async () => { throw new Error('D1_ERROR: no such table: release_metadata: SQLITE_ERROR') }
      return { bind() { return this }, first: fail, all: fail, run: fail }
    },
    async batch() { throw new Error('unexpected batch') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
  try {
    const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }
    const response = await worker.fetch(new Request('https://app.tomify.test/api/release-meta', { headers }), { TOMIFY_DB: missingTable })
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error, 'schema-out-of-date')
    assert.deepEqual(body.missing, { kind: 'table', name: 'release_metadata' })
    assert.match(body.message, /Apply the D1 migrations/)
    assert.deepEqual(statements.filter((sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql)), [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the built Worker runs no DDL on the request path', async () => {
  const source = await readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(CREATE (UNIQUE )?(TABLE|INDEX)|ALTER TABLE)\b/)
})

async function withPreflightStubs({ agent, albums = [], songs = [] }, callback) {
  const calls = { agent: [], search3: [] }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } })
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return ok({ user: { adminRole: true } })
    if (url.pathname === '/rest/search3.view') { calls.search3.push(Object.fromEntries(url.searchParams)); return ok({ searchResult3: { album: albums, song: songs } }) }
    if (url.pathname === '/v1/preflight') { calls.agent.push(JSON.parse(init.body)); return agent() }
    return new Response('{}', { status: 404 })
  }
  try { await callback(calls) } finally { globalThis.fetch = originalFetch }
}

const preflightItem = () => recoveryJobDatabase({ status: 'candidate-found', candidate: { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, url: 'https://indexer.test/details/1', title: 'Flood', channel: 'Indexer', provenanceJson: JSON.stringify({ raw: { searchMode: 'release' } }) } })
const preflightGet = (db, query = '') => worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/preflight' + query, { headers: recoveryHeaders }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
const floodExisting = [
  { file: '02 - Birdhouse in Your Soul.flac', path: '/recovery/They Might Be Giants/Flood/02 - Birdhouse in Your Soul.flac', title: 'Birdhouse in Your Soul', trackNumber: 2, discNumber: null, recordingId: null, tier: 'lossless', source: 'sidecar' },
  { file: '03 - Lucky Ball and Chain.mp3', path: '/recovery/They Might Be Giants/Flood/03 - Lucky Ball and Chain.mp3', title: 'Lucky Ball and Chain', trackNumber: 3, discNumber: null, recordingId: null, tier: 'lossy', source: 'tags' },
]

test('the duplicate preflight reports the recovery release directory and the same album already in the library', async () => {
  const albums = [{ id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', songCount: 19 }, { id: 'album-2', name: 'Flood', artist: 'Boris', songCount: 4 }, { id: 'album-3', name: 'Flood (Deluxe)', artist: 'They Might Be Giants', songCount: 25 }]
  await withPreflightStubs({ agent: () => Response.json({ directory: '/recovery/They Might Be Giants/Flood', mode: 'release', existing: floodExisting }), albums }, async (calls) => {
    const response = await preflightGet(preflightItem(), '?mode=release')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(calls.agent, [{ artist: 'They Might Be Giants', album: 'Flood', title: 'Birdhouse in Your Soul', mode: 'release' }])
    assert.equal(calls.search3[0].query, 'Flood')
    assert.equal(calls.search3[0].albumCount, '20')
    assert.equal(body.directory, '/recovery/They Might Be Giants/Flood')
    assert.deepEqual(body.recovery.map((track) => track.title), ['Birdhouse in Your Soul', 'Lucky Ball and Chain'])
    assert.deepEqual(body.library, [{ kind: 'album', id: 'album-1', title: 'Flood', artist: 'They Might Be Giants', songCount: 19 }])
  })
})

test('a track preflight only counts the same title, in recovery and in the library', async () => {
  const songs = [{ id: 'song-1', title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', path: 'They Might Be Giants/Flood/02.flac' }, { id: 'song-2', title: 'Birdhouse in Your Soul', artist: 'Someone Covering It', album: 'Covers' }]
  await withPreflightStubs({ agent: () => Response.json({ directory: '/recovery/They Might Be Giants/Flood', mode: 'track', existing: floodExisting }), songs }, async (calls) => {
    const body = await (await preflightGet(preflightItem(), '?mode=track')).json()
    assert.equal(calls.search3[0].query, 'Birdhouse in Your Soul')
    assert.deepEqual(body.recovery.map((track) => track.title), ['Birdhouse in Your Soul'])
    assert.deepEqual(body.library.map((song) => song.id), ['song-1'])
  })
})

test('the duplicate preflight treats an older agent without /v1/preflight as unknown, not as a failure', async () => {
  await withPreflightStubs({ agent: () => Response.json({ error: 'not-found' }, { status: 404 }), albums: [{ id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', songCount: 19 }] }, async () => {
    const response = await preflightGet(preflightItem(), '?mode=release')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.recovery, null)
    assert.equal(body.directory, null)
    assert.equal(body.library.length, 1)
  })
})

test('acquire passes skipExisting on to the agent', async () => {
  const db = recoveryJobDatabase({ status: 'candidate-found', candidate: { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: null, url: 'https://indexer.test/details/1', externalId: 'x', title: 'Flood', channel: 'Indexer', provenanceJson: JSON.stringify({ raw: { searchMode: 'release' } }) } })
  await withRecoveryAgent((path) => path === '/v1/status' ? Response.json({ contract: 2, backends: [] }) : Response.json({ job: { id: 'job-1', status: 'queued', progress: 0 } }, { status: 202 }), async (requests) => {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/acquire', { method: 'POST', headers: recoveryHeaders, body: JSON.stringify({ candidateId: 'candidate-1', confirmedAuthorised: true, rightsBasis: 'other-authorisation', skipExisting: true }) }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 202)
    assert.equal(requests.find(([path]) => path === '/v1/acquire')[1].skipExisting, true)
  })
})

test('adaptive streaming checks the Navidrome login in the query and signs every playlist line it passes on', async () => {
  const originalFetch = globalThis.fetch
  const agentCalls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: url.searchParams.get('u') === 'hls-listener' ? 'ok' : 'failed' } })
    agentCalls.push({ url, headers: init.headers })
    if (url.pathname.endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=70400\nv0/index.m3u8\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
    if (url.pathname.endsWith('/index.m3u8')) return new Response('#EXTM3U\n#EXTINF:6.000,\nseg00000.ts\n#EXT-X-ENDLIST\n')
    return new Response('chunk', { headers: { 'content-type': 'video/mp2t', 'content-length': '5' } })
  }
  const env = { RECOVERY_AGENT_URL: 'https://agent-hls.tomify.test/', RECOVERY_AGENT_TOKEN: 'agent-secret' }
  const query = 'u=hls-listener&t=0123456789abcdef0123456789abcdef&s=salt1'
  try {
    const refused = await worker.fetch(new Request('https://app.tomify.test/api/hls/tr1/master.m3u8?u=someone&t=0123456789abcdef0123456789abcdef&s=salt1'), env)
    assert.equal(refused.status, 401)
    assert.equal(agentCalls.length, 0)

    const master = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/master.m3u8?${query}`), env)
    assert.equal(master.status, 200)
    assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl')
    assert.equal(await master.text(), `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=70400\nv0/index.m3u8?${query}\n`)
    assert.equal(agentCalls[0].url.href, 'https://agent-hls.tomify.test/v1/hls/tr1/master.m3u8')
    assert.equal(agentCalls[0].headers.authorization, 'Bearer agent-secret')
    assert.equal(agentCalls[0].headers['x-tomify-navidrome-user'], 'hls-listener')
    assert.equal(agentCalls[0].headers['x-tomify-navidrome-origin'], TEST_NAVIDROME_ORIGIN)

    const playlist = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/v0/index.m3u8?${query}`), env)
    assert.match(await playlist.text(), new RegExp(`\\nseg00000\\.ts\\?${query.replace(/[?]/g, '\\?')}\\n`))

    const chunk = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/v0/seg00000.ts?${query}`), env)
    assert.equal(chunk.headers.get('content-type'), 'video/mp2t')
    assert.equal(await chunk.text(), 'chunk')

    // A loudness-normalised stream keeps its mode in the path; the playlist's relative lines stay under it.
    const normalised = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/album/master.m3u8?${query}`), env)
    assert.equal(await normalised.text(), `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=70400\nv0/index.m3u8?${query}\n`)
    assert.equal(agentCalls[3].url.href, 'https://agent-hls.tomify.test/v1/hls/tr1/album/master.m3u8')
    const normalisedChunk = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/track/v2/seg00001.ts?${query}`), env)
    assert.equal(normalisedChunk.status, 200)
    assert.equal(agentCalls[4].url.href, 'https://agent-hls.tomify.test/v1/hls/tr1/track/v2/seg00001.ts')

    for (const path of ['/api/hls/tr1/source', '/api/hls/..%2Fx/master.m3u8', '/api/hls/tr1/v0/../../v1/status', '/api/hls/tr1/loud/master.m3u8', '/api/hls/tr1/album/album/master.m3u8']) {
      const response = await worker.fetch(new Request(`https://app.tomify.test${path}?${query}`), env)
      assert.equal(response.status, 404, path)
    }
    assert.equal(agentCalls.length, 5)
  } finally { globalThis.fetch = originalFetch }
})

test('adaptive streaming reports "unavailable" for an agent without it, so the player streams originals', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    return Response.json({ error: 'not-found' }, { status: 404 })
  }
  const query = 'u=hls-old-agent&t=0123456789abcdef0123456789abcdef&s=salt2'
  try {
    const old = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/master.m3u8?${query}`), { RECOVERY_AGENT_URL: 'https://agent-old.tomify.test' })
    assert.equal(old.status, 503)
    assert.equal((await old.json()).error, 'hls-unavailable')
    // An agent from before loudness normalisation doesn't know the mode path either.
    const oldNormalised = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/track/master.m3u8?${query}`), { RECOVERY_AGENT_URL: 'https://agent-old.tomify.test' })
    assert.equal((await oldNormalised.json()).error, 'hls-unavailable')
    const unconfigured = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/master.m3u8?${query}`), {})
    assert.equal(unconfigured.status, 503)
  } finally { globalThis.fetch = originalFetch }
})

test('the daily refresh saves Spotify changes, and opening the playlist queues what is still missing for Recovery', async () => {
  const db = await sqliteDatabase()
  const spotifyEnv = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret', SPOTIFY_TOKEN_ENCRYPTION_KEY: 'test-key' }
  const env = { TOMIFY_DB: db, ...spotifyEnv }
  db.sqlite.prepare("INSERT INTO catalogue_provider_tokens (username, provider, encrypted_token) VALUES ('tom', 'spotify', ?)").run(await encryptCatalogueToken(spotifyEnv, { accessToken: 'user-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }))
  db.sqlite.prepare("INSERT INTO catalogue_playlists (id, username, name, provider, provider_playlist_id, source_url, snapshot_id, provenance_json) VALUES ('imp-1', 'tom', 'Flood', 'spotify', 'sp1', 'https://open.spotify.com/playlist/sp1', 'snap-1', ?)").run(JSON.stringify({ autoRecovery: true }))
  db.sqlite.prepare("INSERT INTO catalogue_playlist_items (id, playlist_id, position, provider_track_id, metadata_json, status, local_track_id, local_track_json, match_confidence) VALUES ('item-1', 'imp-1', 0, 't1', ?, 'available', 'nav-1', ?, 98)").run(JSON.stringify({ title: 'Birdhouse in Your Soul', artists: ['They Might Be Giants'] }), JSON.stringify({ id: 'nav-1', title: 'Birdhouse in Your Soul' }))
  const track = (id, name) => ({ type: 'track', id, name, artists: [{ id: 'a1', name: 'They Might Be Giants' }], album: { id: 'al1', name: 'Flood', images: [] }, duration_ms: 180000, external_urls: { spotify: 'https://open.spotify.com/track/' + id } })
  let snapshot = 'snap-2'
  const spotify = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.spotify.com') {
      spotify.push(url.pathname + url.search)
      if (url.searchParams.get('fields') === 'snapshot_id') return Response.json({ snapshot_id: snapshot })
      if (url.pathname.endsWith('/items')) return Response.json({ items: [{ item: track('t1', 'Birdhouse in Your Soul') }, { item: track('t2', 'Particle Man') }], next: null })
      return Response.json({ id: 'sp1', name: 'Flood', snapshot_id: snapshot, images: [] })
    }
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
  const runCron = async () => { const pending = []; await builtWorker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) }); await Promise.all(pending) }
  try {
    await runCron()
    const items = () => db.sqlite.prepare('SELECT provider_track_id AS track, status, local_track_id AS local, recovery_id AS recovery FROM catalogue_playlist_items ORDER BY position').all().map((row) => ({ ...row }))
    assert.deepEqual(items(), [{ track: 't1', status: 'available', local: 'nav-1', recovery: null }, { track: 't2', status: 'missing', local: null, recovery: null }])
    const saved = db.sqlite.prepare("SELECT snapshot_id AS snapshot, provenance_json AS provenance FROM catalogue_playlists WHERE id = 'imp-1'").get()
    assert.equal(saved.snapshot, 'snap-2')
    assert.equal(JSON.parse(saved.provenance).autoRecovery, true, 'the refresh keeps the import\'s Recovery choice')
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM recovery_items').get().count, 0, 'nothing goes to Recovery before the library is searched')

    spotify.length = 0
    await runCron()
    assert.deepEqual(spotify, ['/v1/playlists/sp1?fields=snapshot_id'], 'an unchanged snapshot is not fetched again')

    const resolved = await worker.fetch(new Request('https://app.tomify.test/api/catalogue-playlists/imp-1/resolve', { method: 'PATCH', headers: recoveryHeaders, body: JSON.stringify({ items: [], queueMissing: true }) }), env)
    assert.equal(resolved.status, 200)
    const recovery = db.sqlite.prepare('SELECT id, artist, title, status FROM recovery_items').all().map((row) => ({ ...row }))
    assert.deepEqual(recovery.map(({ artist, title, status }) => ({ artist, title, status })), [{ artist: 'They Might Be Giants', title: 'Particle Man', status: 'missing' }])
    assert.equal(items()[1].recovery, recovery[0].id)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('album completeness can queue the missing tracks as one release item, and lists incomplete albums', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const tracklist = { albumId: 'album-1', releaseId: 'rel-1', releaseGroupId: 'group-1', title: 'Flood', artist: 'They Might Be Giants', date: '1990-01-15', source: 'auto', localTrackCount: 1,
    tracks: ['Theme From Flood', 'Birdhouse in Your Soul', 'Lucky Ball and Chain'].map((title, index) => ({ key: `1-${index + 1}`, disc: 1, number: index + 1, title, artist: 'They Might Be Giants', length: 60, recordingId: null })) }
  db.sqlite.prepare("INSERT INTO release_tracklists (album_id, release_id, source, tracklist_json, fetched_at) VALUES ('album-1', 'rel-1', 'auto', ?, '2026-10-19 10:00:00')").run(JSON.stringify(tracklist))
  db.sqlite.prepare("INSERT INTO release_tracklists (album_id, release_id, source, tracklist_json) VALUES ('album-2', 'rel-2', 'auto', ?)").run(JSON.stringify({ ...tracklist, albumId: 'album-2', title: 'Lincoln', localTrackCount: 3 }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view' || url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: true } } })
    return new Response('{}', { status: 404 })
  }
  const call = (path, body) => worker.fetch(new Request(`https://app.tomify.test/api/album-completeness/${path}`, { method: 'POST', headers: recoveryHeaders, body: JSON.stringify(body) }), env)
  try {
    const added = await call('recovery', { albumId: 'album-1', trackKeys: ['1-1', '1-3'], release: true })
    assert.equal(added.status, 201)
    const rows = db.sqlite.prepare('SELECT id, artist, title, album, status, source_json AS source FROM recovery_items').all().map((row) => ({ ...row, source: JSON.parse(row.source) }))
    assert.deepEqual(rows.map(({ artist, title, album, status, source }) => ({ artist, title, album, status, albumId: source.albumId, releaseId: source.releaseId, trackKeys: source.trackKeys })), [{ artist: 'They Might Be Giants', title: '', album: 'Flood', status: 'missing', albumId: 'album-1', releaseId: 'rel-1', trackKeys: ['1-1', '1-3'] }])
    assert.deepEqual((await added.json()).recovery['1-3'], { id: rows[0].id, status: 'missing' }, 'the release item stands in for each missing track')

    const repeated = await call('recovery', { albumId: 'album-1', trackKeys: ['1-1', '1-3'], release: true })
    assert.equal(repeated.status, 200)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM recovery_items').get().count, 1)

    const overview = await call('overview', {})
    assert.equal(overview.status, 200)
    assert.deepEqual((await overview.json()).albums, [{ albumId: 'album-1', title: 'Flood', artist: 'They Might Be Giants', total: 3, present: 1, queued: 2, checkedAt: '2026-10-19 10:00:00' }])

    // Once the release has imported, tracks it lacked show as missing again.
    db.sqlite.prepare("UPDATE recovery_items SET status = 'recovered'").run()
    const after = await call('recovery', { albumId: 'album-1', trackKeys: ['1-3'] })
    assert.equal(after.status, 201)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('smart playlists are saved per account, and listening stats total the recorded plays', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    return new Response('{}', { status: 404 })
  }
  const call = (path, init = {}, user = 'tom') => worker.fetch(new Request(`https://app.tomify.test${path}`, { ...init, headers: { ...recoveryHeaders, 'x-tomify-user': user } }), env)
  try {
    const created = await call('/api/smart-playlists', { method: 'POST', body: JSON.stringify({ name: 'Jazz', rules: { genres: ['Jazz'], sort: 'random' } }) })
    assert.equal(created.status, 201)
    const { id } = await created.json()
    assert.equal((await call('/api/smart-playlists', { method: 'POST', body: JSON.stringify({ name: '', rules: {} }) })).status, 400)
    const updated = await call(`/api/smart-playlists/${id}`, { method: 'PUT', body: JSON.stringify({ name: 'Late jazz', rules: { genres: ['Jazz'], yearFrom: 1960 } }) })
    assert.deepEqual(await updated.json().then(({ name, rules }) => ({ name, rules })), { name: 'Late jazz', rules: { genres: ['Jazz'], yearFrom: 1960 } })
    assert.deepEqual((await (await call('/api/smart-playlists')).json()).playlists.map((playlist) => playlist.name), ['Late jazz'])
    assert.deepEqual((await (await call('/api/smart-playlists', {}, 'anna')).json()).playlists, [], 'other accounts do not see them')
    assert.equal((await call(`/api/smart-playlists/${id}`, { method: 'PUT', body: JSON.stringify({ name: 'x', rules: {} }) }, 'anna')).status, 404)
    assert.equal((await call(`/api/smart-playlists/${id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await call(`/api/smart-playlists/${id}`)).status, 404)

    const now = Date.now()
    const play = (track, artist, album, seconds, skipped = 0, ago = 0) => db.sqlite.prepare('INSERT INTO listening_events (username, track_id, album_id, artist_id, title, artist, album, listened_seconds, completed, skipped, played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('tom', track, album + '-id', artist + '-id', track, artist, album, seconds, skipped ? 0 : 1, skipped, now - ago)
    play('So What', 'Miles Davis', 'Kind of Blue', 540)
    play('So What', 'Miles Davis', 'Kind of Blue', 540)
    play('Blue in Green', 'Miles Davis', 'Kind of Blue', 330)
    play('Teen Spirit', 'Nirvana', 'Nevermind', 10, 1)
    play('Old', 'Someone', 'Gone', 200, 0, 40 * 86_400_000)
    const stats = await (await call('/api/listening/stats?days=30')).json()
    assert.deepEqual({ plays: stats.plays, skips: stats.skips, seconds: stats.seconds }, { plays: 4, skips: 1, seconds: 1420 })
    assert.deepEqual(stats.artists.map(({ artist, plays }) => ({ artist, plays })), [{ artist: 'Miles Davis', plays: 3 }], 'skips are left out of the top lists')
    assert.deepEqual(stats.tracks.map(({ trackId, plays }) => ({ trackId, plays })), [{ trackId: 'So What', plays: 2 }, { trackId: 'Blue in Green', plays: 1 }])
    assert.equal(stats.albums[0].album, 'Kind of Blue')
    assert.equal((await (await call('/api/listening/stats?days=365')).json()).plays, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('lyrics come from LRCLIB once per song, misses are saved, and an LRCLIB outage is not', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db }
  const originalFetch = globalThis.fetch
  const searched = []
  let lrclib = (url) => Response.json(url.searchParams.get('track_name') === 'Karma Police'
    ? [{ duration: 400, syncedLyrics: '[00:01.00]other edit' }, { duration: 263, plainLyrics: 'plain only' }, { duration: 265, syncedLyrics: '[00:10.00]Karma police' }]
    : [])
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.hostname === 'lrclib.net') { searched.push(url); return lrclib(url) }
    return new Response('{}', { status: 404 })
  }
  const call = (query) => worker.fetch(new Request(`https://app.tomify.test/api/lyrics?${new URLSearchParams(query)}`, { headers: recoveryHeaders }), env)
  try {
    assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/lyrics?id=1&artist=a&title=b'), env)).status, 401)
    assert.equal((await call({ id: 's1', artist: 'Radiohead' })).status, 400)
    const song = { id: 's1', artist: 'Radiohead', title: 'Karma Police', duration: '264' }
    assert.deepEqual(await (await call(song)).json(), { synced: '[00:10.00]Karma police', plain: null }, 'synced lyrics within 3 s of the song win')
    assert.equal(searched[0].pathname, '/api/search')
    assert.equal(searched[0].searchParams.get('artist_name'), 'Radiohead')
    assert.deepEqual(await (await call(song)).json(), { synced: '[00:10.00]Karma police', plain: null })
    assert.equal(searched.length, 1, 'the saved lyrics answer the second time')

    const missing = { id: 's2', artist: 'Nobody', title: 'Unknown', duration: '100' }
    assert.deepEqual(await (await call(missing)).json(), { synced: null, plain: null })
    await call(missing)
    assert.equal(searched.length, 2, 'a miss is saved too')
    db.sqlite.prepare('UPDATE lyrics SET checked_at = ? WHERE song_id = ?').run(Date.now() - 31 * 86_400_000, 's2')
    await call(missing)
    assert.equal(searched.length, 3, 'and looked up again after a month')

    lrclib = () => new Response('busy', { status: 503 })
    assert.equal((await call({ id: 's3', artist: 'A', title: 'B' })).status, 502)
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM lyrics WHERE song_id = 's3'").get().count, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media sessions seal the login into a short-lived token that streams, HLS and the box accept instead of the login', async () => {
  const originalFetch = globalThis.fetch
  const outbound = []
  const login = { user: 'media-listener', token: '0123456789abcdef0123456789abcdef', salt: 'salt7' }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: url.searchParams.get('u') === login.user && url.searchParams.get('t') === login.token ? 'ok' : 'failed' } })
    if (url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: false } } })
    outbound.push({ url, headers: init.headers })
    if (url.pathname.endsWith('/master.m3u8')) return new Response('#EXTM3U\nv0/index.m3u8\n')
    return new Response('audio', { status: 200 })
  }
  const env = { TOMIFY_MEDIA_KEY: 'm'.repeat(40), TOMIFY_LAN_ORIGIN: 'https://lan.tomify.test:8789', RECOVERY_AGENT_URL: 'https://agent-media.tomify.test' }
  const headers = { 'x-tomify-user': login.user, 'x-tomify-token': login.token, 'x-tomify-salt': login.salt }
  const session = (init, extra = env) => worker.fetch(new Request('https://app.tomify.test/api/media-session', init), extra)
  try {
    assert.equal((await session({ method: 'POST', headers }, {})).status, 404)
    assert.equal((await session({ method: 'GET', headers })).status, 405)
    assert.equal((await session({ method: 'POST', headers: { ...headers, 'x-tomify-token': 'f'.repeat(32) } })).status, 401)
    const before = Date.now()
    const granted = await session({ method: 'POST', headers })
    assert.equal(granted.status, 200)
    const body = await granted.json()
    assert.equal(body.lanOrigin, env.TOMIFY_LAN_ORIGIN)
    assert.ok(body.expiresAt >= before + 4 * 3600_000 - 1000 && body.expiresAt <= Date.now() + 4 * 3600_000)
    assert.equal(body.token.includes(login.token), false)
    // The box's LAN listener opens the same token with the same key.
    assert.deepEqual(openMediaToken(env.TOMIFY_MEDIA_KEY, body.token), { user: login.user, token: login.token, salt: login.salt })
    assert.equal(openMediaToken('x'.repeat(40), body.token), null)
    assert.equal(openMediaToken(env.TOMIFY_MEDIA_KEY, body.token, body.expiresAt + 1), null)

    const mt = encodeURIComponent(body.token)
    const stream = await worker.fetch(new Request(`https://app.tomify.test/navidrome/rest/stream.view?id=tr1&v=1.16.1&c=Tomify&mt=${mt}`), env)
    assert.equal(stream.status, 200)
    assert.equal(outbound[0].url.origin + outbound[0].url.pathname, TEST_NAVIDROME_ORIGIN + '/rest/stream.view')
    assert.deepEqual(Object.fromEntries(outbound[0].url.searchParams), { id: 'tr1', v: '1.16.1', c: 'Tomify', u: login.user, t: login.token, s: login.salt })
    // Only streams take a token, and only a token the Worker sealed.
    for (const path of [`/navidrome/rest/getUser.view?username=x&mt=${mt}`, '/navidrome/rest/stream.view?id=tr1&mt=forged.token', `/navidrome/rest/stream.view?id=tr1&mt=${mt}x`]) {
      assert.equal((await worker.fetch(new Request(`https://app.tomify.test${path}`), env)).status, 401, path)
    }
    assert.equal((await worker.fetch(new Request(`https://app.tomify.test/navidrome/rest/stream.view?id=tr1&mt=${mt}`), { ...env, TOMIFY_MEDIA_KEY: undefined })).status, 401)
    assert.equal(outbound.length, 1)

    const master = await worker.fetch(new Request(`https://app.tomify.test/api/hls/tr1/master.m3u8?mt=${mt}`), env)
    assert.equal(master.status, 200)
    assert.equal(await master.text(), `#EXTM3U\nv0/index.m3u8?${new URLSearchParams({ mt: body.token })}\n`)
    assert.equal(outbound[1].headers['x-tomify-navidrome-user'], login.user)
    assert.equal(outbound[1].headers['x-tomify-navidrome-token'], login.token)
    assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/hls/tr1/master.m3u8?mt=forged.token'), env)).status, 401)
  } finally { globalThis.fetch = originalFetch }
})

test('party mode: guests join with a code, search as the host, and add tracks within the limits', async () => {
  const db = await sqliteDatabase()
  const env = { TOMIFY_DB: db, TOMIFY_MEDIA_KEY: 'party-test-key' }
  const searches = []
  const originalFetch = globalThis.fetch
  const song = (id) => ({ id, title: `Song ${id}`, artist: 'Pulp', album: 'Different Class', coverArt: `al-${id}`, duration: 200, path: '/srv/music/secret.flac' })
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.pathname === '/rest/search3.view') { searches.push(Object.fromEntries(url.searchParams)); return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: { song: [song('s1'), song('s2')] } } }) }
    if (url.pathname === '/rest/getSong.view') return Response.json({ 'subsonic-response': url.searchParams.get('id') === 'missing' ? { status: 'failed', error: { code: 70 } } : { status: 'ok', song: song(url.searchParams.get('id')) } })
    return new Response('{}', { status: 404 })
  }
  const host = (path = '', method = 'GET', body) => worker.fetch(new Request(`https://app.tomify.test/api/party${path}`, { method, headers: recoveryHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }), env)
  const guest = (token, path = '', method = 'GET', body) => worker.fetch(new Request(`https://app.tomify.test/api/party/guest${path}`, { method, headers: { 'x-tomify-party': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env)
  const join = (code, name) => worker.fetch(new Request('https://app.tomify.test/api/party/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) }), env)
  try {
    assert.equal((await worker.fetch(new Request('https://app.tomify.test/api/party', { method: 'POST', headers: recoveryHeaders, body: '{}' }), { TOMIFY_DB: db })).status, 503, 'needs a key to seal the host login')
    assert.deepEqual(await (await host()).json(), { party: null })
    const started = await host('', 'POST', { name: 'Tomify Rocks!', cooldownSeconds: 0, maxPerGuest: 2, voting: true })
    assert.equal(started.status, 201)
    const { party } = await started.json()
    assert.equal(party.name, 'Tomify Rocks!')
    assert.match(party.code, /^[A-Z2-9]{6}$/)
    assert.equal(db.sqlite.prepare('SELECT credential FROM parties').get().credential.includes('token'), false, 'the host login is sealed')

    assert.equal((await join('NOPE00', 'Anna')).status, 404)
    assert.equal((await join(party.code, '')).status, 400)
    const anna = (await (await join(party.code.toLowerCase(), 'Anna')).json()).token
    const ben = (await (await join(party.code, 'Ben')).json()).token
    assert.equal((await guest('wrong')).status, 401)

    const results = await (await guest(anna, '/search?q=pulp')).json()
    assert.deepEqual(results.tracks.map((track) => track.id), ['s1', 's2'])
    assert.equal(results.tracks[0].path, undefined, 'file paths are not shown to guests')
    assert.deepEqual([searches[0].u, searches[0].t, searches[0].s], ['tom', 'token', 'salt'], 'guests search as the host')

    assert.equal((await guest(anna, '/queue', 'POST', { trackId: 's1' })).status, 201)
    assert.equal((await guest(ben, '/queue', 'POST', { trackId: 's1' })).status, 409, 'no duplicates')
    assert.equal((await guest(anna, '/queue', 'POST', { trackId: 'missing' })).status, 404)
    assert.equal((await guest(anna, '/queue', 'POST', { trackId: 's2' })).status, 201)
    const limited = await guest(anna, '/queue', 'POST', { trackId: 's3' })
    assert.equal(limited.status, 409, 'two waiting per guest')
    assert.match((await limited.json()).message, /2 waiting/)
    const benAdded = await (await guest(ben, '/queue', 'POST', { trackId: 's4' })).json()
    assert.deepEqual(benAdded.queue.map((item) => [item.track.id, item.mine]), [['s1', false], ['s4', true], ['s2', false]], 'guests take turns')

    const s2 = benAdded.queue.find((item) => item.track.id === 's2')
    const voted = await (await guest(ben, `/vote/${s2.id}`, 'POST')).json()
    assert.deepEqual(voted.queue.map((item) => [item.track.id, item.votes, item.voted]), [['s2', 1, true], ['s1', 0, false], ['s4', 0, false]])

    let hosted = await (await host()).json()
    assert.deepEqual(hosted.queue.map((item) => item.track.id), ['s2', 's1', 's4'])
    assert.deepEqual(hosted.guests.map((value) => value.name), ['Anna', 'Ben'])
    await host(`/items/${hosted.queue[0].id}`, 'POST', { state: 'queued' })
    await host('', 'PATCH', { nowPlaying: song('s9'), cooldownSeconds: 120 })
    const view = await (await guest(anna)).json()
    assert.equal(view.nowPlaying.title, 'Song s9')
    assert.equal(view.nowPlaying.path, undefined)
    assert.equal(view.queue[0].state, 'queued')
    assert.equal((await guest(anna, `/vote/${view.queue[0].id}`, 'POST')).status, 404, 'no voting once it is up next')
    await host(`/items/${hosted.queue[0].id}`, 'POST', { state: 'played' })
    const cooled = await guest(anna, '/queue', 'POST', { trackId: 's5' })
    assert.equal(cooled.status, 429, 'cooldown after the last add')
    assert.match((await cooled.json()).message, /seconds/)
    await host('', 'PATCH', { cooldownSeconds: 0 })
    assert.equal((await guest(anna, '/queue', 'POST', { trackId: 's2' })).status, 409, 'played in the last hour')

    hosted = await (await host()).json()
    const benId = hosted.guests.find((value) => value.name === 'Ben').id
    hosted = await (await host(`/guests/${benId}`, 'DELETE')).json()
    assert.deepEqual(hosted.queue.map((item) => item.track.id), ['s1'], "a removed guest's waiting tracks go too")
    assert.equal((await guest(ben)).status, 401)

    assert.equal((await host('', 'DELETE')).status, 200)
    assert.equal((await guest(anna)).status, 401)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM parties').get().count, 0)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM party_queue').get().count, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the party queue lets guests take turns, and votes go first when voting is on', () => {
  const entry = (id, guestId, addedAt, votes = 0, state = 'pending') => ({ id, guestId, addedAt, votes, state })
  const turns = [entry('a1', 'anna', 1), entry('a2', 'anna', 2), entry('a3', 'anna', 3), entry('b1', 'ben', 4), entry('c1', 'cara', 5), entry('b2', 'ben', 6)]
  assert.deepEqual(orderPartyQueue(turns, false).map((value) => value.id), ['a1', 'b1', 'c1', 'a2', 'b2', 'a3'])
  const votes = [entry('a1', 'anna', 1), entry('b1', 'ben', 2, 3), entry('c1', 'cara', 3, 1), entry('q', 'dan', 0, 0, 'queued')]
  assert.deepEqual(orderPartyQueue(votes, true).map((value) => value.id), ['q', 'b1', 'c1', 'a1'], 'the up-next track stays at the top')
  assert.deepEqual(orderPartyQueue(votes, false).map((value) => value.id), ['q', 'a1', 'b1', 'c1'])
})
