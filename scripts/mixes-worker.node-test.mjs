import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { cleanListeningEvent, handleListeningRequest } from '../worker/features/listening.ts'
import { buildCandidates, buildSimpleMixes, createMixesHandler, curatorRequest, mixesFromCurated, spreadArtists } from '../worker/features/mixes.ts'
import { curateMixesWithClaude, DEFAULT_MIXES_MODEL, parseCuratedMixes } from '../worker/features/mix-curator.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-17T09:00:00Z')

// A D1-shaped wrapper around node:sqlite with every migration applied.
function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } } },
  })
  return { raw: db, prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((item) => item.run())) }
}

const song = (id, artist, extra = {}) => ({ id, title: `Song ${id}`, artist, album: `${artist} album`, albumId: `al-${artist}`, coverArt: `al-${artist}`, duration: 200, ...extra })
const subsonic = (body) => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }), { status: 200 })
const authHeaders = { 'x-tomify-user': 'Tom', 'x-tomify-token': 'token', 'x-tomify-salt': 'salt' }

test('listening events keep the useful fields and reject plays that never happened', () => {
  const event = cleanListeningEvent({ trackId: 't1', title: ' Dreams ', artist: 'Fleetwood Mac', listenedSeconds: 250.4, durationSeconds: 257, completed: true, skipped: true, playedAt: NOW - 1000 }, NOW)
  assert.equal(event.title, 'Dreams')
  assert.equal(event.listenedSeconds, 250)
  assert.equal(event.completed, true)
  assert.equal(event.skipped, false, 'a finished track is never a skip')
  assert.equal(cleanListeningEvent({ trackId: 't1', listenedSeconds: 0 }, NOW), null)
  assert.equal(cleanListeningEvent({ listenedSeconds: 30 }, NOW), null)
  assert.equal(cleanListeningEvent({ trackId: 't1', listenedSeconds: 30, playedAt: NOW + DAY }, NOW).playedAt, NOW, 'a play time in the future is replaced with now')
})

test('the listening endpoint stores plays for the signed-in account', async (t) => {
  const db = d1()
  t.mock.method(globalThis, 'fetch', async () => subsonic({}))
  const request = new Request('https://tomify.test/api/listening', { method: 'POST', headers: authHeaders, body: JSON.stringify({ events: [{ trackId: 't1', artist: 'Muse', listenedSeconds: 40, skipped: false }, { nonsense: true }] }) })
  const response = await handleListeningRequest(request, { TOMIFY_DB: db, NAVIDROME_ORIGIN: 'https://navidrome.test' }, new URL(request.url))
  assert.deepEqual(await response.json(), { recorded: 1 })
  assert.deepEqual(db.raw.prepare('SELECT username, track_id, artist FROM listening_events').all().map((row) => ({ ...row })), [{ username: 'tom', track_id: 't1', artist: 'Muse' }])
})

const insertPlay = (db, { track, artist, album = `${artist} album`, genre = null, seconds = 200, skipped = 0, at, user = 'tom' }) => db.raw.prepare('INSERT INTO listening_events (username, track_id, album_id, artist_id, title, artist, album, listened_seconds, completed, skipped, played_at, genre) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(user, track, `${album}-id`, `${artist}-id`, `${track} title`, artist, album, seconds, skipped ? 0 : 1, skipped, at, genre)
const listeningCall = (db, path, init = {}) => {
  const request = new Request(`https://tomify.test${path}`, { ...init, headers: authHeaders })
  return handleListeningRequest(request, { TOMIFY_DB: db, NAVIDROME_ORIGIN: 'https://navidrome.test' }, new URL(request.url))
}

test('listening stats take calendar periods, list top genres and the years Wrapped can show', async (t) => {
  const db = d1()
  t.mock.method(globalThis, 'fetch', async () => subsonic({}))
  const march = Date.UTC(2025, 2, 10), may = Date.UTC(2025, 4, 2)
  insertPlay(db, { track: 'a', artist: 'Muse', genre: 'Rock', at: march })
  insertPlay(db, { track: 'b', artist: 'Muse', genre: 'rock', at: march + 1000 })
  insertPlay(db, { track: 'c', artist: 'Björk', genre: 'Electronic', at: march + 2000 })
  insertPlay(db, { track: 'd', artist: 'Björk', genre: 'Electronic', skipped: 1, seconds: 5, at: march + 3000 })
  insertPlay(db, { track: 'e', artist: 'Nirvana', genre: 'Grunge', at: may })
  insertPlay(db, { track: 'f', artist: 'Nirvana', at: may, user: 'anna' })
  const stats = await (await listeningCall(db, `/api/listening/stats?from=${Date.UTC(2025, 2, 1)}&to=${Date.UTC(2025, 3, 1)}`)).json()
  assert.equal(stats.days, null)
  assert.deepEqual({ plays: stats.plays, skips: stats.skips }, { plays: 4, skips: 1 }, 'only March, and only this account')
  assert.deepEqual(stats.genres.map(({ genre, plays }) => ({ genre: genre.toLowerCase(), plays })), [{ genre: 'rock', plays: 2 }, { genre: 'electronic', plays: 1 }], 'genres group regardless of case, without skips')
  assert.deepEqual(stats.years, [2025])
  const rolling = await (await listeningCall(db, '/api/listening/stats?days=7')).json()
  assert.equal(rolling.days, 7)
  assert.equal(rolling.plays, 0)
})

test('Wrapped sums up a year and compares it with the year before', async (t) => {
  const db = d1()
  t.mock.method(globalThis, 'fetch', async () => subsonic({}))
  insertPlay(db, { track: 'old', artist: 'Muse', at: Date.UTC(2024, 5, 1), seconds: 1000 })
  insertPlay(db, { track: 'first', artist: 'Muse', genre: 'Rock', at: Date.UTC(2025, 0, 1, 0, 30) })
  for (let i = 0; i < 3; i += 1) insertPlay(db, { track: 'loop', artist: 'Wet Leg', genre: 'Indie', at: Date.UTC(2025, 6, 4, 10 + i) })
  insertPlay(db, { track: 'loop', artist: 'Wet Leg', genre: 'Indie', at: Date.UTC(2025, 6, 9) })
  insertPlay(db, { track: 'skip', artist: 'Someone', skipped: 1, seconds: 4, at: Date.UTC(2025, 6, 9) })
  insertPlay(db, { track: 'next-year', artist: 'Muse', at: Date.UTC(2026, 0, 1, 1) })
  const wrapped = await (await listeningCall(db, '/api/listening/wrapped?year=2025')).json()
  assert.equal(wrapped.year, 2025)
  assert.equal(wrapped.plays, 6)
  assert.equal(wrapped.firstTrack.trackId, 'first')
  assert.deepEqual({ trackId: wrapped.mostRepeated.trackId, day: wrapped.mostRepeated.day, plays: wrapped.mostRepeated.plays }, { trackId: 'loop', day: '2025-07-04', plays: 3 })
  assert.deepEqual(wrapped.months.map(({ month, plays }) => ({ month, plays })), [{ month: 1, plays: 1 }, { month: 7, plays: 5 }])
  assert.equal(wrapped.newArtistCount, 1, 'Muse was played the year before, and skips do not count')
  assert.equal(wrapped.newArtists[0].artist, 'Wet Leg')
  assert.deepEqual(wrapped.playlist, ['loop', 'first'])
  assert.deepEqual(wrapped.genres.map((row) => row.genre), ['Indie', 'Rock'])
  assert.deepEqual(wrapped.previous, { year: 2024, plays: 1, seconds: 1000 })
  assert.equal((await listeningCall(db, '/api/listening/wrapped?year=1999')).status, 400)
  assert.equal((await listeningCall(db, `/api/listening/wrapped?year=${new Date().getUTCFullYear() + 1}`)).status, 400)
})

test('a year is saved as a Wrapped recap before its plays are pruned', async (t) => {
  const db = d1()
  t.mock.method(globalThis, 'fetch', async () => subsonic({}))
  const year = new Date().getUTCFullYear() - 3
  insertPlay(db, { track: 'gone', artist: 'Muse', genre: 'Rock', at: Date.UTC(year, 3, 1) })
  insertPlay(db, { track: 'gone', artist: 'Muse', genre: 'Rock', at: Date.UTC(year, 3, 2) })
  const posted = await listeningCall(db, '/api/listening', { method: 'POST', body: JSON.stringify({ events: [{ trackId: 'now', artist: 'Muse', genre: 'Rock', listenedSeconds: 40 }] }) })
  assert.deepEqual(await posted.json(), { recorded: 1 })
  assert.deepEqual(db.raw.prepare('SELECT track_id, genre FROM listening_events').all().map((row) => ({ ...row })), [{ track_id: 'now', genre: 'Rock' }], 'old plays are pruned, and the genre is stored')
  assert.deepEqual(db.raw.prepare('SELECT year FROM listening_years').all().map((row) => row.year), [year], 'only years that had plays are saved')
  const wrapped = await (await listeningCall(db, `/api/listening/wrapped?year=${year}`)).json()
  assert.equal(wrapped.plays, 2)
  assert.deepEqual(wrapped.playlist, ['gone'])
  const stats = await (await listeningCall(db, '/api/listening/stats?days=30')).json()
  assert.ok(stats.years.includes(year), 'saved years are still offered')
  insertPlay(db, { track: 'late', artist: 'Muse', at: Date.UTC(year, 5, 1) })
  await listeningCall(db, '/api/listening', { method: 'POST', body: JSON.stringify({ events: [{ trackId: 'again', listenedSeconds: 40 }] }) })
  assert.equal((await (await listeningCall(db, `/api/listening/wrapped?year=${year}`)).json()).plays, 2, 'a saved recap is not rebuilt from what is left')
})

test('songs you keep skipping are left out of the candidates', () => {
  const candidates = buildCandidates({
    songs: [{ song: song('a', 'Muse'), source: 'library' }, { song: song('b', 'Muse'), source: 'library' }, { song: song('a', 'Muse'), source: 'favourite' }],
    stats: [{ trackId: 'b', artist: 'Muse', artistId: null, plays: 3, skips: 3, completions: 0, lastPlayed: NOW - DAY }],
    topArtists: ['Muse'],
  }, NOW)
  assert.deepEqual(candidates.map((candidate) => candidate.song.id), ['a'])
  assert.deepEqual(candidates[0].sources, ['library', 'favourite'])
  assert.equal(candidates[0].starred, true)
})

test('simple mixes cover on repeat, artist mixes, rediscover and new music without repeating an artist back to back', () => {
  const songs = []
  for (let index = 0; index < 12; index += 1) songs.push({ song: song(`m${index}`, 'Muse', { playCount: 5, played: new Date(NOW - 2 * DAY).toISOString() }), source: 'top-songs:Muse' })
  for (let index = 0; index < 12; index += 1) songs.push({ song: song(`r${index}`, `Similar ${index % 4}`), source: 'similar-to:Muse' })
  for (let index = 0; index < 12; index += 1) songs.push({ song: song(`o${index}`, `Old ${index % 6}`, { playCount: 8, played: new Date(NOW - 400 * DAY).toISOString(), starred: '2020-01-01' }), source: 'favourite' })
  for (let index = 0; index < 12; index += 1) songs.push({ song: song(`n${index}`, `New ${index % 3}`, { playCount: 0 }), source: 'recently-added' })
  const candidates = buildCandidates({ songs, stats: [], topArtists: ['Muse'] }, NOW)
  const mixes = buildSimpleMixes(candidates, ['Muse'], NOW, 'tom:2026-10-17')
  assert.deepEqual(mixes.map((mix) => mix.kind), ['on-repeat', 'artist-mix', 'rediscover', 'fresh', 'deep-cuts'])
  assert.deepEqual(mixes.map((mix) => mix.id), ['mix-1', 'mix-2', 'mix-3', 'mix-4', 'mix-5'])
  const artistMix = mixes[1]
  assert.equal(artistMix.title, 'Muse mix')
  assert.ok(artistMix.tracks.some((track) => track.artist !== 'Muse'), 'an artist mix brings in similar artists')
  assert.ok(mixes[2].tracks.every((track) => track.id.startsWith('o')), 'rediscover is old favourites')
  for (const mix of mixes.slice(1)) for (let index = 1; index < mix.tracks.length; index += 1) assert.notEqual(mix.tracks[index].artist, mix.tracks[index - 1].artist, `${mix.title} repeats an artist`)
  assert.deepEqual(buildSimpleMixes(candidates, ['Muse'], NOW, 'tom:2026-10-17'), mixes, 'the same day gives the same mixes')
})

test('spreading artists keeps every track and only bunches up when it has to', () => {
  const spread = spreadArtists([{ artist: 'A' }, { artist: 'A' }, { artist: 'A' }, { artist: 'B' }, { artist: 'C' }])
  assert.deepEqual(spread.map((track) => track.artist), ['A', 'B', 'A', 'C', 'A'])
})

test('Claude only sees song references and only songs from the pool make it into a mix', () => {
  const candidates = buildCandidates({ songs: Array.from({ length: 10 }, (_, index) => ({ song: song(`s${index}`, `Artist ${index}`, { year: 1977, genre: 'Rock' }), source: 'favourite' })), stats: [], topArtists: ['Artist 1'] }, NOW)
  const { request, refs } = curatorRequest(candidates, { songs: [], stats: [], topArtists: ['Artist 1'] }, NOW)
  assert.match(request.candidates, /^t1 \| Artist 0 - Song s0 \| Artist 0 album \(1977, Rock\) \| plays 0, last never, favourite \| favourite$/m)
  assert.match(request.profile, /Artists played most lately: Artist 1/)
  const mixes = mixesFromCurated([
    { title: 'Seventies rock', description: 'All from 1977.', trackRefs: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 'made-up', 't1'] },
    { title: 'Too short', description: 'Not enough songs.', trackRefs: ['t1', 't2'] },
  ], refs)
  assert.equal(mixes.length, 1)
  assert.equal(mixes[0].tracks.length, 8)
  assert.equal(mixes[0].kind, 'claude')
})

test('the Claude request uses structured output, low effort and the server-side fallback', async () => {
  let sent
  const fetcher = async (url, init) => { sent = { url, headers: init.headers, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ mixes: [{ title: 'Mix', description: 'Nice.', trackRefs: ['t1', 2] }] }) }] })) }
  const mixes = await curateMixesWithClaude({ ANTHROPIC_API_KEY: 'key' }, { profile: 'p', candidates: 'c' }, fetcher)
  assert.deepEqual(mixes, [{ title: 'Mix', description: 'Nice.', trackRefs: ['t1'] }])
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(sent.headers['x-api-key'], 'key')
  assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01')
  assert.equal(sent.body.model, DEFAULT_MIXES_MODEL)
  assert.equal(sent.body.fallbacks, 'default')
  assert.equal(sent.body.output_config.effort, 'low')
  assert.equal(sent.body.output_config.format.type, 'json_schema')
  const refusing = async (url, init) => { sent = { headers: init.headers, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ stop_reason: 'refusal', content: [] })) }
  await assert.rejects(curateMixesWithClaude({ TOMIFY_MIXES_MODEL: 'claude-haiku-5-5' }, { profile: 'p', candidates: 'c' }, refusing), /declined/)
  assert.equal(sent.body.model, 'claude-haiku-5-5')
  assert.equal(sent.body.fallbacks, undefined, 'Haiku has no server-side fallback')
  assert.equal(sent.headers['anthropic-beta'], undefined)
  const overloaded = async () => new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 529 })
  await assert.rejects(curateMixesWithClaude({}, { profile: 'p', candidates: 'c' }, overloaded), /Claude API 529: Overloaded/)
  assert.throws(() => parseCuratedMixes('{"nope":1}'), /did not return any mixes/)
})

function navidromeFetch(calls) {
  return async (input) => {
    const url = new URL(String(input))
    const endpoint = url.pathname.replace(/^\/rest\/|\.view$/g, '')
    calls.push(endpoint)
    const muse = Array.from({ length: 12 }, (_, index) => song(`m${index}`, 'Muse', { playCount: 4, played: new Date(NOW - DAY).toISOString() }))
    const others = Array.from({ length: 30 }, (_, index) => song(`x${index}`, `Band ${index % 5}`, { playCount: 0 }))
    switch (endpoint) {
      case 'ping': return subsonic({})
      case 'getAlbumList2': return subsonic({ albumList2: { album: url.searchParams.get('type') === 'frequent' ? [{ id: 'al-Muse', artist: 'Muse', artistId: 'ar-muse' }] : [] } })
      case 'getStarred2': return subsonic({ starred2: { song: [] } })
      case 'getRandomSongs': return subsonic({ randomSongs: { song: others } })
      case 'getTopSongs': return subsonic({ topSongs: { song: muse } })
      case 'getSimilarSongs2': return subsonic({ similarSongs2: { song: others.slice(0, 15) } })
      case 'getAlbum': return subsonic({ album: { song: muse } })
      default: return new Response('{}', { status: 404 })
    }
  }
}

test('mixes are built once a day, stored per account, and fall back to simple mixes when Claude fails', async (t) => {
  const db = d1()
  const calls = []
  t.mock.method(globalThis, 'fetch', navidromeFetch(calls))
  t.mock.method(Date, 'now', () => NOW)
  const env = { TOMIFY_DB: db, NAVIDROME_ORIGIN: 'https://navidrome.test', ANTHROPIC_API_KEY: 'key' }
  let curateCalls = 0
  const handler = createMixesHandler({ curate: async () => { curateCalls += 1; throw new Error('overloaded') } })
  const call = (path, init = {}) => { const request = new Request(`https://tomify.test${path}`, { ...init, headers: authHeaders }); return handler(request, env, new URL(request.url)) }

  const empty = await (await call('/api/mixes')).json()
  assert.equal(empty.stale, true)
  assert.deepEqual(empty.mixes, [])

  const built = await (await call('/api/mixes/refresh', { method: 'POST', body: '{}' })).json()
  assert.equal(curateCalls, 1)
  assert.equal(built.curatedBy, 'tomify')
  assert.match(built.lastError, /Claude was unavailable \(overloaded\)/)
  assert.ok(built.mixes.length >= 2)
  assert.equal(built.stale, false)
  assert.ok(calls.includes('getSimilarSongs2'))

  const again = await (await call('/api/mixes/refresh', { method: 'POST', body: '{}' })).json()
  assert.equal(curateCalls, 1, 'fresh mixes are not rebuilt')
  assert.deepEqual(again.mixes, built.mixes)

  const forcedTooSoon = await (await call('/api/mixes/refresh', { method: 'POST', body: '{"force":true}' })).json()
  assert.equal(curateCalls, 1, 'a manual refresh within ten minutes is ignored')
  assert.deepEqual(forcedTooSoon.mixes, built.mixes)
})

test('Claude-picked mixes are stored and a second tab waits instead of building again', async (t) => {
  const db = d1()
  t.mock.method(globalThis, 'fetch', navidromeFetch([]))
  t.mock.method(Date, 'now', () => NOW)
  const env = { TOMIFY_DB: db, NAVIDROME_ORIGIN: 'https://navidrome.test', ANTHROPIC_API_KEY: 'key' }
  const refs = Array.from({ length: 12 }, (_, index) => `t${index + 1}`)
  const handler = createMixesHandler({ curate: async () => [{ title: 'Saturday morning', description: 'Easy does it.', trackRefs: refs }, { title: 'Loud', description: 'Turn it up.', trackRefs: [...refs].reverse() }] })
  const call = (path, init = {}) => { const request = new Request(`https://tomify.test${path}`, { ...init, headers: authHeaders }); return handler(request, env, new URL(request.url)) }

  db.raw.prepare('INSERT INTO made_for_you (username, refresh_started_at) VALUES (?, ?)').run('tom', NOW - 1000)
  const waiting = await call('/api/mixes/refresh', { method: 'POST', body: '{}' })
  assert.equal(waiting.status, 202)
  assert.equal((await waiting.json()).refreshing, true)

  db.raw.prepare('UPDATE made_for_you SET refresh_started_at = ?').run(NOW - 10 * 60 * 1000)
  const built = await (await call('/api/mixes/refresh', { method: 'POST', body: '{}' })).json()
  assert.equal(built.curatedBy, 'claude')
  assert.deepEqual(built.mixes.map((mix) => mix.title), ['Saturday morning', 'Loud'])
  assert.equal(built.mixes[0].tracks.length, 12)
  assert.equal(built.refreshing, false)
  assert.equal(built.lastError, null)
})

test('mixes need a signed-in account', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed' } })))
  const request = new Request('https://tomify.test/api/mixes', { headers: { ...authHeaders, 'x-tomify-token': 'wrong' } })
  const response = await createMixesHandler()(request, { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test' }, new URL(request.url))
  assert.equal(response.status, 401)
})
