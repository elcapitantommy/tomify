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

test('album artwork applies a confident Spotify match automatically but never replaces a manual choice', async () => {
  const spotifySearches = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'spotify-token', expires_in: 3600 })
    if (url.hostname === 'api.spotify.com') {
      spotifySearches.push(url.searchParams.get('q'))
      const items = url.searchParams.get('q')?.startsWith('album:Flood ') ? [{ id: 'sp-flood', name: 'Flood', release_date: '1990-01-15', artists: [{ name: 'They Might Be Giants' }], images: [{ url: 'https://i.scdn.co/image/flood-640', width: 640, height: 640 }, { url: 'https://i.scdn.co/image/flood-64', width: 64, height: 64 }], external_urls: { spotify: 'https://open.spotify.com/album/sp-flood' } }] : []
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
    assert.deepEqual(spotifySearches, ['album:Flood (2013 Remaster) artist:They Might Be Giants', 'album:Flood artist:They Might Be Giants'])

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
    assert.equal(listed.spotifyAvailable, true)
    assert.deepEqual(listed.items.map((item) => [item.albumId, item.provider]), [['album-1', 'library']])

    await call('reset', { albumId: 'album-1' })
    assert.equal(env.TOMIFY_DB.rows.size, 0)

    const none = await call('auto', { albumId: 'album-2', name: 'Unknown Thing', artist: 'Nobody' }).then((response) => response.json())
    assert.deepEqual([none.applied, none.reason], [false, 'no-match'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('album artwork lookups report a missing Spotify configuration', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ 'subsonic-response': { status: 'ok' } })
  try {
    const response = await worker.fetch(new Request('https://app.tomify.test/api/album-artwork/lookup', { method: 'POST', headers: { 'x-tomify-user': 'tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }, body: JSON.stringify({ albumId: 'album-1', name: 'Flood', artist: 'They Might Be Giants' }) }), { TOMIFY_DB: artworkDatabase() })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'spotify-unavailable')
  } finally {
    globalThis.fetch = originalFetch
  }
})
