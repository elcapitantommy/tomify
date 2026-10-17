import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildSegment, cleanSegmentRequest, createDjHandler, DEFAULT_DJ_VOICE, DJ_TTS_MODEL, djPool, djPrompt, partOfDay, plainSegment, ukDate } from '../worker/features/dj.ts'
import { buildCandidates } from '../worker/features/mixes.ts'

const NOW = Date.parse('2026-10-17T08:30:00Z')
const song = (id, artist, extra = {}) => ({ id, title: `Song ${id}`, artist, album: `${artist} album`, albumId: `al-${artist}`, duration: 200, ...extra })
const subsonic = (body) => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }), { status: 200 })
const headers = { 'x-tomify-user': 'Tom', 'x-tomify-token': 'dj-token', 'x-tomify-salt': 'salt' }
const pool = buildCandidates({ songs: Array.from({ length: 20 }, (_, index) => ({ song: song(`s${index}`, `Artist ${index % 5}`), source: index < 10 ? 'favourite' : 'library' })), stats: [], topArtists: ['Artist 1'] }, NOW)
const snapshot = { songs: [], stats: [], topArtists: ['Artist 1'] }
const input = (extra = {}) => ({ recentTrackIds: [], request: null, first: true, username: 'Tom', now: NOW, ...extra })

function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({ bind: (...next) => statement(sql, next), first: async () => db.prepare(sql).get(...values) ?? null, all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }) })
  return { prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((item) => item.run())) }
}

test('segment requests are cleaned and the time of day is UK time', () => {
  assert.deepEqual(cleanSegmentRequest({ recentTrackIds: ['a', 2, 'b'], request: '  something calmer  ', first: true }), { recentTrackIds: ['a', 'b'], request: 'something calmer', first: true })
  assert.deepEqual(cleanSegmentRequest(null), { recentTrackIds: [], request: null, first: false })
  assert.equal(partOfDay(NOW), 'morning')
  assert.equal(partOfDay(Date.parse('2026-10-17T17:30:00Z')), 'evening', '18:30 BST')
  assert.equal(ukDate(Date.parse('2026-10-17T17:30:00Z')), 'Saturday 17 October')
  assert.equal(ukDate(Date.parse('2026-10-17T23:30:00Z')), 'Sunday 18 October', '00:30 BST is already Sunday')
})

test('the DJ never picks a song from this session again', () => {
  const picked = djPool(pool, ['s0', 's1', 's2'], 'seed')
  assert.equal(picked.length, 17)
  assert.ok(!picked.some((candidate) => ['s0', 's1', 's2'].includes(candidate.song.id)))
  assert.ok(picked.slice(0, 7).every((candidate) => candidate.sources.includes('favourite')), 'songs with a reason come first')
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
