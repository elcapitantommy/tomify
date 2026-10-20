import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { artistKey, checkNewReleases, cleanArtists, pickArtist, recentReleases, releaseDateEnd } from '../worker/features/new-releases.ts'

const NOW = Date.parse('2026-10-20T12:00:00Z')

function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({ bind: (...next) => statement(sql, next), first: async () => db.prepare(sql).get(...values) ?? null, all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }) })
  return { raw: db, prepare: (sql) => statement(sql), batch: async (statements) => { for (const item of statements) await item.run() } }
}

test('artist names match across spelling, accents and "The"', () => {
  assert.equal(artistKey('Mötley Crüe'), artistKey('Motley Crue'))
  assert.equal(artistKey('The Beatles'), artistKey('Beatles'))
  assert.equal(artistKey('Earth, Wind & Fire'), 'earthwindandfire')
  const cleaned = cleanArtists({ artists: [{ name: 'Muse', musicBrainzId: '9C9F1380-2516-4FC9-A3E6-F9F61941D090' }, { name: 'muse' }, { name: 'Various Artists' }, { name: '  ' }, { name: 'Ash', musicBrainzId: 'not-an-id' }] })
  assert.deepEqual(cleaned, [{ key: 'muse', name: 'Muse', musicBrainzId: '9c9f1380-2516-4fc9-a3e6-f9f61941d090' }, { key: 'ash', name: 'Ash', musicBrainzId: null }])
  assert.deepEqual(cleanArtists(null), [])
})

test('only albums, EPs and singles from the last year count, announced ones included', () => {
  assert.equal(releaseDateEnd('2026'), Date.UTC(2026, 11, 31))
  assert.equal(releaseDateEnd('2026-02'), Date.UTC(2026, 1, 28))
  assert.equal(releaseDateEnd('nonsense'), null)
  const groups = [
    { id: 'g1', title: 'New Album', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2026-09-12' },
    { id: 'g2', title: 'Old Album', 'primary-type': 'Album', 'first-release-date': '2019-05-01' },
    { id: 'g3', title: 'Greatest Hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'], 'first-release-date': '2026-06-01' },
    { id: 'g4', title: 'Coming Soon', 'primary-type': 'Single', 'first-release-date': '2026-12-01' },
    { id: 'g5', title: 'Live at Wembley', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '2026-03' },
    { id: 'g6', title: 'Undated', 'primary-type': 'EP', 'first-release-date': '' },
    { id: 'g7', title: 'Broadcast', 'primary-type': 'Broadcast', 'first-release-date': '2026-10-01' },
  ]
  assert.deepEqual(recentReleases(groups, NOW).map((release) => release.id), ['g1', 'g4', 'g5'])
})

test('an artist is only matched on MusicBrainz by a confident, same-name result', () => {
  const id = '9c9f1380-2516-4fc9-a3e6-f9f61941d090'
  assert.equal(pickArtist({ artists: [{ id, name: 'Muse', score: 100 }] }, 'Muse'), id)
  assert.equal(pickArtist({ artists: [{ id, name: 'Muse Tribute', score: 100 }] }, 'Muse'), null)
  assert.equal(pickArtist({ artists: [{ id, name: 'Muse', score: 60 }] }, 'Muse'), null)
  assert.equal(pickArtist(null, 'Muse'), null)
})

test('the nightly check looks artists up, saves new releases and checks the oldest first', async () => {
  const db = d1()
  const id = '9c9f1380-2516-4fc9-a3e6-f9f61941d090'
  db.raw.prepare('INSERT INTO new_release_artists (artist_key, name, musicbrainz_id, checked_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('ash', 'Ash', null, NOW - 1000, NOW)
  db.raw.prepare('INSERT INTO new_release_artists (artist_key, name, musicbrainz_id, checked_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('muse', 'Muse', null, null, NOW)
  const calls = []
  const mb = async (url) => {
    calls.push(url.pathname + url.search)
    if (url.pathname === '/ws/2/artist/') return { artists: [{ id, name: 'Muse', score: 100 }] }
    return { 'release-groups': [{ id: 'g1', title: 'Wow! Signal', 'primary-type': 'Album', 'first-release-date': '2026-09-26' }] }
  }
  assert.equal(await checkNewReleases({ TOMIFY_DB: db }, 1, NOW, mb), 1)
  assert.ok(calls[0].includes('artist%3A%22Muse%22'), 'never-checked Muse goes before Ash')
  assert.ok(calls[1].includes(`artist=${id}`))
  assert.deepEqual(db.raw.prepare('SELECT artist_name AS artist, title, release_type AS type, release_date AS date FROM new_releases').all().map((row) => ({ ...row })), [{ artist: 'Muse', title: 'Wow! Signal', type: 'album', date: '2026-09-26' }])
  assert.equal(db.raw.prepare("SELECT musicbrainz_id AS id FROM new_release_artists WHERE artist_key = 'muse'").get().id, id)
})

test('a MusicBrainz outage leaves the artist to be checked again', async () => {
  const db = d1()
  db.raw.prepare('INSERT INTO new_release_artists (artist_key, name, musicbrainz_id, checked_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('muse', 'Muse', '9c9f1380-2516-4fc9-a3e6-f9f61941d090', null, NOW)
  assert.equal(await checkNewReleases({ TOMIFY_DB: db }, 5, NOW, async () => null), 0)
  assert.equal(db.raw.prepare("SELECT checked_at FROM new_release_artists WHERE artist_key = 'muse'").get().checked_at, null)
})

test('pages send the artist list and read back the releases', async (t) => {
  const { handleNewReleasesRequest } = await import('../worker/features/new-releases.ts')
  const db = d1()
  const env = { TOMIFY_DB: db, NAVIDROME_ORIGIN: 'https://music.example' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok' } }))
  t.after(() => { globalThis.fetch = realFetch })
  const headers = { 'x-tomify-user': 'tom', 'x-tomify-token': 'nr-token', 'x-tomify-salt': 'salt' }
  const call = (path, init = {}) => { const request = new Request('https://app.example' + path, { ...init, headers: { ...headers, ...init.headers } }); return handleNewReleasesRequest(request, env, new URL(request.url), { waitUntil: () => {} }) }

  assert.equal((await handleNewReleasesRequest(new Request('https://app.example/api/new-releases'), env, new URL('https://app.example/api/new-releases'))).status, 401)
  const posted = await call('/api/new-releases/artists', { method: 'POST', body: JSON.stringify({ artists: [{ name: 'Muse' }, { name: 'Ash' }] }) })
  assert.deepEqual(await posted.json(), { artists: 2 })
  db.raw.prepare("INSERT INTO new_releases VALUES ('g1', 'muse', 'Muse', 'Wow! Signal', 'album', ?, ?)").run(new Date().toISOString().slice(0, 10), Date.now())
  db.raw.prepare("INSERT INTO new_releases VALUES ('g0', 'muse', 'Muse', 'Drones', 'album', '2015-06-08', ?)").run(Date.now())
  const body = await (await call('/api/new-releases')).json()
  assert.deepEqual(body.releases.map((release) => release.title), ['Wow! Signal'])
  assert.equal(body.artists, 2)
  assert.equal(body.checked, 0)
  assert.equal(await call('/api/other'), null)
})
