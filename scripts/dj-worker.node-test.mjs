import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildSegment, cleanSegmentRequest, createDjHandler, DEFAULT_DJ_VOICE, DJ_POOL_PER_ARTIST, DJ_TTS_MODEL, djPool, djPrompt, partOfDay, plainSegment, styleMatcher, ukDate } from '../worker/features/dj.ts'
import { buildCandidates } from '../worker/features/mixes.ts'

const NOW = Date.parse('2026-10-17T08:30:00Z')
const song = (id, artist, extra = {}) => ({ id, title: `Song ${id}`, artist, album: `${artist} album`, albumId: `al-${artist}`, duration: 200, ...extra })
const subsonic = (body) => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }), { status: 200 })
const headers = { 'x-tomify-user': 'Tom', 'x-tomify-token': 'dj-token', 'x-tomify-salt': 'salt' }
const pool = buildCandidates({ songs: Array.from({ length: 20 }, (_, index) => ({ song: song(`s${index}`, `Artist ${index % 5}`), source: index < 10 ? 'favourite' : 'library' })), stats: [], topArtists: ['Artist 1'] }, NOW)
const snapshot = { songs: [], stats: [], topArtists: ['Artist 1'] }
const input = (extra = {}) => ({ recentTrackIds: [], recentArtists: [], request: null, first: true, username: 'Tom', now: NOW, ...extra })

function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({ bind: (...next) => statement(sql, next), first: async () => db.prepare(sql).get(...values) ?? null, all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }) })
  return { prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((item) => item.run())) }
}

test('segment requests are cleaned and the time of day is UK time', () => {
  assert.deepEqual(cleanSegmentRequest({ recentTrackIds: ['a', 2, 'b'], recentArtists: ['Blur', '', 3, 'Oasis'], request: '  something calmer  ', first: true }), { recentTrackIds: ['a', 'b'], recentArtists: ['Blur', 'Oasis'], request: 'something calmer', first: true })
  assert.deepEqual(cleanSegmentRequest(null), { recentTrackIds: [], recentArtists: [], request: null, first: false })
  assert.equal(partOfDay(NOW), 'morning')
  assert.equal(partOfDay(Date.parse('2026-10-17T17:30:00Z')), 'evening', '18:30 BST')
  assert.equal(ukDate(Date.parse('2026-10-17T17:30:00Z')), 'Saturday 17 October')
  assert.equal(ukDate(Date.parse('2026-10-17T23:30:00Z')), 'Sunday 18 October', '00:30 BST is already Sunday')
})

test('the DJ never picks a song from this session again', () => {
  const picked = djPool(pool, ['s0', 's1', 's2'], 'seed')
  assert.equal(picked.length, 15, `17 fresh songs, at most ${DJ_POOL_PER_ARTIST} per artist`)
  assert.ok(!picked.some((candidate) => ['s0', 's1', 's2'].includes(candidate.song.id)))
  assert.ok(picked.slice(0, 7).every((candidate) => candidate.sources.includes('favourite')), 'songs with a reason come first')
})

// A library like the real one: lots of songs gathered for the 5 most played artists (top songs, similar
// songs that are mostly the same artists, most played albums, favourites), and random picks from 80 others.
function realisticPool() {
  const top = ['Blur', 'Oasis', 'Pulp', 'Suede', 'Elastica']
  const songs = []
  top.forEach((artist, a) => {
    for (let index = 0; index < 15; index += 1) songs.push({ song: song(`top-${a}-${index}`, artist), source: `top-songs:${artist}` })
    for (let index = 0; index < 30; index += 1) songs.push({ song: song(`sim-${a}-${index}`, top[(a + index) % top.length]), source: `similar-to:${artist}` })
    for (let index = 0; index < 12; index += 1) songs.push({ song: song(`alb-${a}-${index}`, artist), source: 'most-played-album' })
    for (let index = 0; index < 6; index += 1) songs.push({ song: song(`fav-${a}-${index}`, artist), source: 'favourite' })
  })
  for (let index = 0; index < 200; index += 1) songs.push({ song: song(`lib-${index}`, `Library artist ${index % 80}`), source: 'library' })
  return { pool: buildCandidates({ songs, stats: [], topArtists: top }, NOW), top }
}

test('the DJ pool is not taken over by the few most played artists', () => {
  const { pool: library, top } = realisticPool()
  const picked = djPool(library, [], 'seed')
  const artists = new Map()
  for (const candidate of picked) artists.set(candidate.song.artist, (artists.get(candidate.song.artist) ?? 0) + 1)
  assert.ok(Math.max(...artists.values()) <= DJ_POOL_PER_ARTIST)
  assert.ok(artists.size >= 40, `only ${artists.size} artists in the pool`)
  assert.ok(picked.filter((candidate) => top.includes(candidate.song.artist)).length <= top.length * DJ_POOL_PER_ARTIST)
})

test('artists from the last few sets are rested while there is enough else to play', () => {
  const { pool: library, top } = realisticPool()
  const rested = djPool(library, [], 'seed', 150, top)
  assert.ok(!rested.some((candidate) => top.includes(candidate.song.artist)))
  const smallLibrary = djPool(pool, [], 'seed', 150, ['Artist 0', 'Artist 1'])
  assert.ok(smallLibrary.some((candidate) => candidate.song.artist === 'Artist 0'), 'with only a few artists nobody is rested')
  assert.ok(!smallLibrary.slice(0, 9).some((candidate) => ['Artist 0', 'Artist 1'].includes(candidate.song.artist)), 'but they come last')
})

test('a set plays several different artists and Claude is told who to rest', async () => {
  const { pool: library } = realisticPool()
  let asked
  const claude = async (env, system, prompt) => {
    asked = prompt
    const refs = [...prompt.matchAll(/^(t\d+) \| Library artist 3 - /gm)].map((match) => match[1])
    return { script: 'More from one artist.', trackRefs: [...refs, 't1'] }
  }
  const segment = await buildSegment({ ANTHROPIC_API_KEY: 'key' }, library, snapshot, input({ recentArtists: ['Blur'] }), { claude })
  assert.equal(new Set(segment.tracks.map((track) => track.artist)).size, segment.tracks.length, 'one song per artist in a set')
  assert.match(asked, /^Played this session, so rest them unless asked: Blur\.$/m)
  assert.doesNotMatch(asked, / \| Blur - /, 'resting artists are left out of the pool')
  const steered = await buildSegment({ ANTHROPIC_API_KEY: 'key' }, library, snapshot, input({ recentArtists: ['Blur'], request: 'more Blur' }), { claude: async (env, system, prompt) => { asked = prompt; return { script: 'x', trackRefs: ['t1'] } } })
  assert.equal(steered.curatedBy, 'claude')
  assert.match(asked, / \| Blur - /, 'a request can bring a resting artist back')
})

test('the DJ prompt names the listener, the time and any request', () => {
  const { prompt, refs } = djPrompt(pool.slice(0, 3), snapshot, input({ request: 'more 80s' }))
  assert.match(prompt, /^Listener: Tom\. It is Saturday 17 October, morning in the UK\.$/m)
  assert.match(prompt, /first link of the session/)
  assert.match(prompt, /The listener asked: "more 80s"/)
  assert.match(prompt, /^t1 \| Artist 0 - Song s0 \|/m)
  assert.equal(refs.size, 3)
})

test('without Claude the DJ plays one song per artist and reads a plain intro', () => {
  const segment = plainSegment(pool, input())
  assert.equal(segment.tracks.length, 4)
  assert.equal(new Set(segment.tracks.map((track) => track.artist)).size, 4)
  assert.equal(segment.script, `Good morning, Tom. Coming up, ${segment.tracks[0].title} by ${segment.tracks[0].artist}, then 3 more from your library.`)
})

test('Claude picks the songs and writes the link, and the plain DJ takes over when it fails', async () => {
  let asked
  const claude = async (env, system, prompt) => { asked = prompt; return { script: 'Morning Tom. Here is an old favourite.', trackRefs: ['t2', 't1', 't2', 'nope'] } }
  const segment = await buildSegment({ ANTHROPIC_API_KEY: 'key' }, pool, snapshot, input(), { claude })
  assert.equal(segment.curatedBy, 'claude')
  assert.equal(segment.script, 'Morning Tom. Here is an old favourite.')
  assert.equal(segment.tracks.length, 2, 'unknown and repeated refs are dropped')
  assert.match(asked, /Candidate songs:/)

  const failed = await buildSegment({ ANTHROPIC_API_KEY: 'key' }, pool, snapshot, input(), { claude: async () => { throw new Error('overloaded') } })
  assert.equal(failed.curatedBy, 'tomify')
  assert.equal(failed.tracks.length, 4)
  const noKey = await buildSegment({}, pool, snapshot, input(), { claude: async () => assert.fail('Claude is not called without a key') })
  assert.equal(noKey.curatedBy, 'tomify')
})

test('the voice endpoint reads the link with Aura-2 and explains when Workers AI is missing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => subsonic({}))
  let ran
  const AI = { run: async (model, inputs, options) => { ran = { model, inputs, options }; return new Response('mp3-bytes', { headers: { 'content-type': 'audio/mpeg' } }) } }
  const call = (env, text) => { const request = new Request('https://tomify.test/api/dj/voice', { method: 'POST', headers, body: JSON.stringify({ text }) }); return createDjHandler()(request, { NAVIDROME_ORIGIN: 'https://navidrome.test', ...env }, new URL(request.url)) }
  const spoken = await call({ AI }, 'Morning Tom.')
  assert.equal(spoken.headers.get('content-type'), 'audio/mpeg')
  assert.equal(await spoken.text(), 'mp3-bytes')
  assert.equal(DEFAULT_DJ_VOICE, 'pandora', 'the British female voice Tom chose')
  assert.deepEqual(ran, { model: DJ_TTS_MODEL, inputs: { text: 'Morning Tom.', speaker: DEFAULT_DJ_VOICE, encoding: 'mp3' }, options: { returnRawResponse: true } })
  await call({ AI, TOMIFY_DJ_VOICE: 'pandora' }, 'Hi.')
  assert.equal(ran.inputs.speaker, 'pandora')
  assert.equal((await call({ AI }, '   ')).status, 400)
  assert.equal((await call({}, 'Hi.')).status, 503)

  t.mock.method(console, 'error', () => undefined)
  const quota = await call({ AI: { run: async () => { throw new Error('4006: you have used up your daily free allocation') } } }, 'Hi.')
  assert.equal(quota.status, 502)
  assert.equal((await quota.json()).message, 'The DJ voice failed: 4006: you have used up your daily free allocation')
  const refused = await call({ AI: { run: async () => new Response('{"errors":[{"message":"bad speaker"}]}', { status: 400 }) } }, 'Hi.')
  assert.equal(refused.status, 502)
  assert.equal((await refused.json()).message, 'The DJ voice failed (400): {"errors":[{"message":"bad speaker"}]}')
})

test('the segment endpoint picks songs from the library for the signed-in account', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  t.mock.method(globalThis, 'fetch', async (input) => {
    const endpoint = new URL(String(input)).pathname.replace(/^\/rest\/|\.view$/g, '')
    if (endpoint === 'getRandomSongs') return subsonic({ randomSongs: { song: pool.map((candidate) => candidate.song) } })
    if (endpoint === 'getAlbumList2') return subsonic({ albumList2: { album: [] } })
    return subsonic({})
  })
  const request = new Request('https://tomify.test/api/dj/segment', { method: 'POST', headers, body: JSON.stringify({ first: true, recentTrackIds: ['s0'] }) })
  const response = await createDjHandler()(request, { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test' }, new URL(request.url))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.curatedBy, 'tomify')
  assert.equal(body.voice, false)
  assert.equal(body.tracks.length, 4)
  assert.ok(!body.tracks.some((track) => track.id === 's0'))
  assert.match(body.script, /^Good morning, Tom\./)
})

test('a request for a genre, mood or tempo matches songs by their tags', () => {
  const house = song('h', 'Bicep', { bpm: 124, genres: [{ name: 'Deep House' }, { name: 'House' }], moods: ['Chill'] })
  const dnb = song('d', 'Goldie', { bpm: 87, genre: 'Drum and Bass' })
  const untagged = song('u', 'Blur')
  const matching = (request) => [house, dnb, untagged].filter(styleMatcher(request)).map((track) => track.id)
  assert.deepEqual(matching('some deep house'), ['h'])
  assert.deepEqual(matching('120-128 bpm'), ['h'])
  assert.deepEqual(matching('around 172 bpm'), ['d'], 'half-time tempos count')
  assert.deepEqual(matching('something calmer'), ['h'], 'everyday words for a mood')
  assert.deepEqual(matching('more Blur'), [])
})

test('matching songs lead the pool and the prompt shows tempo, genre and mood', () => {
  const songs = Array.from({ length: 40 }, (_, index) => ({ song: song(`s${index}`, `Artist ${index}`, index % 10 === 0 ? { bpm: 124, genres: [{ name: 'House' }], moods: ['Upbeat'] } : {}), source: 'library' }))
  const candidates = buildCandidates({ songs, stats: [], topArtists: [] }, NOW)
  const picked = djPool(candidates, [], 'seed', 150, [], styleMatcher('house please'))
  assert.deepEqual(picked.slice(0, 4).map((candidate) => candidate.song.id).sort(), ['s0', 's10', 's20', 's30'])
  const { prompt } = djPrompt(picked.slice(0, 1), snapshot, input())
  assert.match(prompt, /^t1 \| Artist \d+ - Song s\d+ \| Artist \d+ album \| 124 bpm, House, Upbeat \| plays/m)
})

test('a request naming a library genre brings that genre into the pool', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const asked = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(String(input))
    const endpoint = url.pathname.replace(/^\/rest\/|\.view$/g, '')
    asked.push(endpoint === 'getSongsByGenre' ? `${endpoint}:${url.searchParams.get('genre')}` : endpoint)
    if (endpoint === 'getRandomSongs') return subsonic({ randomSongs: { song: pool.map((candidate) => candidate.song) } })
    if (endpoint === 'getAlbumList2') return subsonic({ albumList2: { album: [] } })
    if (endpoint === 'getGenres') return subsonic({ genres: { genre: [{ value: 'Techno' }, { value: 'Rock' }] } })
    if (endpoint === 'getSongsByGenre') return subsonic({ songsByGenre: { song: [song('t1', 'Surgeon', { genre: 'Techno', bpm: 135 }), song('t2', 'Regis', { genre: 'Techno' })] } })
    return subsonic({})
  })
  const request = new Request('https://tomify.test/api/dj/segment', { method: 'POST', headers, body: JSON.stringify({ request: 'some techno' }) })
  const body = await (await createDjHandler()(request, { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test' }, new URL(request.url))).json()
  assert.ok(asked.includes('getSongsByGenre:Techno') && !asked.includes('getSongsByGenre:Rock'))
  assert.deepEqual(body.tracks.slice(0, 2).map((track) => track.id).sort(), ['t1', 't2'])
})
