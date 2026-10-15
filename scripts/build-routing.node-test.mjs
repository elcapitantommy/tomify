import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'vite'
import { catalogueWorkerSource } from './catalogue-worker.mjs'

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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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

test('album completeness reports an unreachable MusicBrainz as a JSON 502', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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

test('Recovery accepts wanted music from any mix of artist, album and track and searches Usenet with combined fields', async () => {
  const agentRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
      if (sql.startsWith('INSERT INTO album_artwork')) {
        const [albumId, provider, providerId, url, width, height, confidence, source, providerAlbum, providerArtist, storeUrl] = this.args
        rows.set(albumId, { albumId, provider, providerId, url, width, height, confidence, source, providerAlbum, providerArtist, storeUrl, updatedAt: 'now' })
      }
      if (sql.startsWith('DELETE FROM album_artwork')) rows.delete(this.args[0])
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
  const { encryptCatalogueToken } = new Function(catalogueWorkerSource + '\nreturn { encryptCatalogueToken }')()
  const encryptedToken = await encryptCatalogueToken(env, { accessToken: 'user-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
  const database = artworkDatabase()
  const prepare = database.prepare
  database.prepare = (sql) => sql.includes('FROM catalogue_provider_tokens') ? { bind() { return this }, async first() { return { encryptedToken } } } : prepare(sql)
  const unavailable = () => new Response('{}', { status: 500 })
  await withArtworkFetch({ 'itunes.apple.com': unavailable, 'api.deezer.com': unavailable, 'api.spotify.com': () => Response.json({ error: { status: 403, message: 'Active premium subscription required for the owner of the app.' } }, { status: 403 }) }, async (requested) => {
    const response = await artworkCall({ ...env, TOMIFY_DB: database }, 'auto', { albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /Spotify search returned HTTP 403: Active premium subscription required for the owner of the app\. Since March 2026 Spotify refuses Development Mode apps whose owner has no Premium subscription\./)
    assert.deepEqual(requested.filter(({ host }) => host === 'api.spotify.com').map(({ authorization }) => authorization), ['Bearer user-token'])
  })
})

test('Recovery explains an out-of-date agent instead of showing not-found', async () => {
  const candidate = { id: 'candidate-1', backend: 'usenet', selected: 1, importedPath: '/recovery/track.mp3', provenanceJson: JSON.stringify({ job: { id: 'job-1', status: 'completed', progress: 100 }, importedTracks: [{ path: '/recovery/track.mp3' }] }) }
  const db = {
    prepare: (sql) => ({ sql, bind() { return this }, async first() { return sql.startsWith('SELECT id, artist, title, album') ? { id: 'recovery-1', artist: 'A', title: 'T', status: 'needs-upgrade' } : null }, async all() { return { results: sql.includes('FROM recovery_candidates') ? [candidate] : [] } }, async run() { return {} } }),
    async batch() { return [] },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => new URL(String(input)).pathname === '/rest/ping.view' ? Response.json({ 'subsonic-response': { status: 'ok' } }) : Response.json({ error: 'not-found' }, { status: 404 })
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/recovery/recovery-1/import-remaining', { method: 'POST', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' } }), { TOMIFY_DB: db, RECOVERY_AGENT_URL: 'https://agent.tomify.test' })
    assert.equal(response.status, 502)
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
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

async function withRebootFetch({ admin, agent }, callback) {
  const originalFetch = globalThis.fetch
  const agentRequests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { username: url.searchParams.get('username'), adminRole: admin } } })
    agentRequests.push({ url: url.href, authorization: init?.headers?.authorization, body: JSON.parse(init?.body || '{}') })
    return agent()
  }
  try { await callback(agentRequests) } finally { globalThis.fetch = originalFetch }
}

const rebootEnv = { RECOVERY_AGENT_URL: 'https://agent.tomify.test', RECOVERY_AGENT_TOKEN: 'agent-token' }
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
