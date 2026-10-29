import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from './server.mjs'
import { createResolver } from './resolver.mjs'
import { createAudioCache } from './cache.mjs'
import { YtDlpError } from './ytdlp.mjs'
import { fakeYouTube, fragmentedMp4, ytdlpInfo } from './testing.mjs'

const TOKEN = 't'.repeat(40)
const VIDEO = 'dQw4w9WgXcQ'

function config(overrides = {}) {
  return { token: TOKEN, maxStreams: 4, searchLimit: 10, cache: { maxConcurrentFills: 2, maxFileBytes: 10_000_000 }, ...overrides }
}

function files(videoId = VIDEO, fixtures = {}) {
  return {
    [`/${videoId}/140`]: fixtures.audio || fragmentedMp4({ count: 6, seconds: 5, fragmentBytes: 900 }),
    [`/${videoId}/139`]: fixtures.audio || fragmentedMp4({ count: 6, seconds: 5, fragmentBytes: 500 }),
    [`/${videoId}/134`]: fixtures.video || fragmentedMp4({ count: 6, seconds: 5, fragmentBytes: 1500 }),
    [`/${videoId}/136`]: fixtures.video || fragmentedMp4({ count: 6, seconds: 5, fragmentBytes: 3000 }),
    [`/${videoId}/137`]: fixtures.video || fragmentedMp4({ count: 6, seconds: 5, fragmentBytes: 6000 }),
    [`/${videoId}/18`]: fixtures.progressive || Buffer.alloc(5000, 0x18),
  }
}

function fakeYtDlp(infoFor, { searchResults = [] } = {}) {
  const calls = { extract: 0, search: [] }
  return {
    calls,
    limiter: { active: 0, queued: 0 },
    async extract(videoId) { calls.extract += 1; return infoFor(videoId, calls.extract) },
    async search(query, limit) { calls.search.push({ query, limit }); return { entries: searchResults } },
    async version() { return '2026.10.26' },
  }
}

async function start({ ytdlp, fetch, cacheDir = null, overrides = {} }) {
  const cache = cacheDir ? createAudioCache({ dir: cacheDir, maxBytes: 50_000_000, maxAgeMs: 3600_000, maxFileBytes: 10_000_000 }) : null
  const resolver = createResolver({ ytdlp, maxHeight: 1080, fetch, audioCache: cache })
  const server = createServer(createHandler({ config: config(overrides), ytdlp, resolver, cache, fetch, version: 'test' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, init = {}) => globalThis.fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } })
  return { base, call, cache, resolver, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }) }
}

test('health needs no token; everything else does', async () => {
  const youtube = fakeYouTube(files())
  const service = await start({ ytdlp: fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) })), fetch: youtube.fetch })
  try {
    assert.deepEqual(await (await globalThis.fetch(`${service.base}/health`)).json(), { ok: true, version: 'test' })
    for (const path of ['/v1/status', `/v1/videos/${VIDEO}`, `/v1/videos/${VIDEO}/140.m4a`, '/v1/search?q=x', `/v1/thumbs/${VIDEO}/hqdefault.jpg`]) {
      assert.equal((await globalThis.fetch(service.base + path)).status, 401, path)
      assert.equal((await globalThis.fetch(service.base + path, { headers: { authorization: 'Bearer wrong' } })).status, 401, path)
    }
    assert.equal(youtube.requests.length, 0)
    assert.equal((await service.call('/anything')).status, 404)
  } finally { await service.close() }
})

test('video details list playable formats and never expose YouTube addresses', async () => {
  const youtube = fakeYouTube(files())
  const ytdlp = fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) }))
  const service = await start({ ytdlp, fetch: youtube.fetch })
  try {
    const response = await service.call(`/v1/videos/${VIDEO}`)
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.doesNotMatch(text, /googlevideo|sig=|expire=/)
    const body = JSON.parse(text)
    assert.equal(body.title, `Video ${VIDEO}`)
    assert.equal(body.channel, 'Test Channel')
    assert.equal(body.duration, 30)
    assert.deepEqual(body.playback, { hls: true, progressive: true, audio: true })
    await service.call(`/v1/videos/${VIDEO}`)
    assert.equal(ytdlp.calls.extract, 1, 'the extraction is cached')
    const resolved = await service.call(`/v1/resolve?url=${encodeURIComponent(`https://youtu.be/${VIDEO}?si=x`)}`)
    assert.equal((await resolved.json()).id, VIDEO)
    const refused = await service.call(`/v1/resolve?url=${encodeURIComponent('https://evil.test/x')}`)
    assert.equal(refused.status, 400)
    assert.equal((await refused.json()).error, 'invalid-url')
  } finally { await service.close() }
})

test('extraction failures are meaningful errors and appear in diagnostics', async () => {
  const ytdlp = fakeYtDlp(() => { throw new YtDlpError('private', 'This video is private.', 403) })
  const service = await start({ ytdlp, fetch: fakeYouTube({}).fetch })
  try {
    const response = await service.call(`/v1/videos/${VIDEO}`)
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'private', message: 'This video is private.' })
    const status = await (await service.call('/v1/status')).json()
    assert.equal(status.ytdlp.version, '2026.10.26')
    assert.equal(status.failures.counts.private, 1)
    assert.equal(status.failures.recent[0].videoId, VIDEO)
    assert.equal((await service.call('/v1/videos/not-an-id')).status, 404)
    const live = await start({ ytdlp: fakeYtDlp((id) => ({ ...ytdlpInfo(id), live_status: 'is_live' })), fetch: fakeYouTube({}).fetch })
    try { assert.equal((await (await live.call(`/v1/videos/${VIDEO}`)).json()).error, 'live-not-supported') } finally { await live.close() }
    const noFormats = await start({ ytdlp: fakeYtDlp((id) => ({ ...ytdlpInfo(id), formats: [] })), fetch: fakeYouTube({}).fetch })
    try { assert.equal((await noFormats.call(`/v1/videos/${VIDEO}`)).status, 422) } finally { await noFormats.close() }
  } finally { await service.close() }
})

test('streams honour byte ranges with the right types and lengths', async () => {
  const fixtures = files()
  const youtube = fakeYouTube(fixtures)
  const service = await start({ ytdlp: fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) })), fetch: youtube.fetch })
  try {
    const audio = fixtures[`/${VIDEO}/140`]
    const partial = await service.call(`/v1/videos/${VIDEO}/140.m4a`, { headers: { range: 'bytes=100-299' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-type'), 'audio/mp4')
    assert.equal(partial.headers.get('accept-ranges'), 'bytes')
    assert.equal(partial.headers.get('content-range'), `bytes 100-299/${audio.length}`)
    assert.equal(partial.headers.get('content-length'), '200')
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), audio.subarray(100, 300))

    const whole = await service.call(`/v1/videos/${VIDEO}/136.mp4`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), fixtures[`/${VIDEO}/136`])

    const tail = await service.call(`/v1/videos/${VIDEO}/progressive.mp4`, { headers: { range: 'bytes=-10' } })
    assert.equal(tail.status, 206)
    assert.equal(tail.headers.get('content-range'), 'bytes 4990-4999/5000')

    const head = await service.call(`/v1/videos/${VIDEO}/140.m4a`, { method: 'HEAD', headers: { range: 'bytes=0-1' } })
    assert.equal(head.status, 206)
    assert.equal(head.headers.get('content-length'), '2')

    const outside = await service.call(`/v1/videos/${VIDEO}/140.m4a`, { headers: { range: `bytes=${audio.length}-` } })
    assert.equal(outside.status, 416)
    assert.equal(outside.headers.get('content-range'), `bytes */${audio.length}`)

    assert.equal((await service.call(`/v1/videos/${VIDEO}/251.m4a`)).status, 404, 'webm/opus is never offered')
    assert.equal((await service.call(`/v1/videos/${VIDEO}/136.m4a`)).status, 404, 'a video itag is not audio')
    assert.equal((await service.call(`/v1/videos/${VIDEO}/../../etc/passwd`)).status, 404)
    for (const request of youtube.requests) assert.equal(request.headers.cookie, undefined)
  } finally { await service.close() }
})

test('an expired YouTube address is renewed without the phone noticing', async () => {
  const youtube = fakeYouTube(files(), { expired: new Set(['4000000000']) })
  // The first extraction hands out addresses that have expired; the second, fresh ones.
  const ytdlp = fakeYtDlp((id, call) => ytdlpInfo(id, { files: files(id), expire: call === 1 ? '4000000000' : '4102444800' }))
  const service = await start({ ytdlp, fetch: youtube.fetch })
  try {
    const response = await service.call(`/v1/videos/${VIDEO}/140.m4a`, { headers: { range: 'bytes=0-99' } })
    assert.equal(response.status, 206)
    assert.equal((await response.arrayBuffer()).byteLength, 100)
    assert.equal(ytdlp.calls.extract, 2)
  } finally { await service.close() }
})

test('HLS playlists describe the streams the service serves', async () => {
  const fixtures = files()
  const service = await start({ ytdlp: fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) })), fetch: fakeYouTube(fixtures).fetch })
  try {
    const master = await service.call(`/v1/videos/${VIDEO}/master.m3u8`)
    assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl')
    const masterText = await master.text()
    assert.match(masterText, /URI="a140\.m3u8"/)
    assert.match(masterText, /^v136\.m3u8$/m)
    const videoOnly = await (await service.call(`/v1/videos/${VIDEO}/video.m3u8`)).text()
    assert.match(videoOnly, /^v136\.m3u8$/m)
    assert.equal(videoOnly.includes('TYPE=AUDIO'), false)
    // ?height=1080: one fixed variant, the largest up to 1080p.
    for (const file of ['master.m3u8', 'video.m3u8']) {
      const fixed = await (await service.call(`/v1/videos/${VIDEO}/${file}?height=1080`)).text()
      assert.deepEqual(fixed.split('\n').filter((line) => /^v\d+\.m3u8$/.test(line)), ['v137.m3u8'], file)
    }
    const variant = await (await service.call(`/v1/videos/${VIDEO}/v136.m3u8`)).text()
    assert.match(variant, /#EXT-X-MAP:URI="136\.mp4",BYTERANGE="\d+@0"/)
    const audio = await (await service.call(`/v1/videos/${VIDEO}/audio.m3u8`)).text()
    assert.match(audio, /^140\.m4a$/m)
    // Every byte range in the playlist starts a fragment of the real file.
    const file = fixtures[`/${VIDEO}/140`]
    for (const [, length, offset] of audio.matchAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g)) {
      assert.equal(file.toString('latin1', Number(offset) + 4, Number(offset) + 8), 'moof')
      assert.ok(Number(offset) + Number(length) <= file.length)
    }
    assert.equal((await service.call(`/v1/videos/${VIDEO}/a136.m3u8`)).status, 404)
  } finally { await service.close() }
})

test('audio mode keeps a copy on disk and then plays from it', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'tomtube-server-cache-'))
  const fixtures = files()
  const youtube = fakeYouTube(fixtures)
  const service = await start({ ytdlp: fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) })), fetch: youtube.fetch, cacheDir })
  try {
    const prefetch = await service.call(`/v1/videos/${VIDEO}/prefetch`, { method: 'POST' })
    assert.equal(prefetch.status, 202)
    assert.equal((await prefetch.json()).state, 'started')
    let cached = null
    for (let attempt = 0; attempt < 50 && !cached; attempt += 1) { cached = await service.cache.lookup(VIDEO, '140'); if (!cached) await new Promise((resolve) => setTimeout(resolve, 20)) }
    assert.ok(cached, 'the audio was cached')
    assert.deepEqual(await readFile(cached.path), fixtures[`/${VIDEO}/140`])
    const before = youtube.requests.length
    const response = await service.call(`/v1/videos/${VIDEO}/140.m4a`, { headers: { range: 'bytes=10-19' } })
    assert.equal(response.headers.get('x-tomtube-source'), 'cache')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtures[`/${VIDEO}/140`].subarray(10, 20))
    assert.equal(youtube.requests.length, before, 'YouTube was not asked again')
    assert.equal((await (await service.call(`/v1/videos/${VIDEO}/prefetch`, { method: 'POST' })).json()).state, 'cached')
    assert.equal((await service.call(`/v1/videos/${VIDEO}/prefetch`)).status, 405)
  } finally { await service.close(); await rm(cacheDir, { recursive: true, force: true }) }
})

test('the queue stream joins several videos and skips ones that fail', async () => {
  const other = 'aaaaaaaaaaa'
  const all = { ...files(), ...files(other) }
  const ytdlp = fakeYtDlp((id) => { if (id === 'bbbbbbbbbbb') throw new YtDlpError('private', 'This video is private.', 403); return ytdlpInfo(id, { files: all }) })
  const service = await start({ ytdlp, fetch: fakeYouTube(all).fetch })
  try {
    const timeline = await (await service.call(`/v1/queue.json?ids=${VIDEO},bbbbbbbbbbb,${other}`)).json()
    assert.deepEqual(timeline.tracks.map((track) => [track.id, track.offset]), [[VIDEO, 0], [other, 30]])
    assert.deepEqual(timeline.skipped, [{ id: 'bbbbbbbbbbb', error: 'private' }])
    const playlist = await (await service.call(`/v1/queue.m3u8?ids=${VIDEO},${other}`)).text()
    assert.match(playlist, new RegExp(`^videos/${other}/140\\.m4a$`, 'm'))
    assert.equal((await service.call('/v1/queue.m3u8?ids=../x')).status, 400)
    assert.equal((await service.call(`/v1/queue.m3u8?ids=${Array(21).fill(VIDEO).join(',')}`)).status, 400)
  } finally { await service.close() }
})

test('search passes the text to yt-dlp; a pasted link opens that video', async () => {
  const ytdlp = fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) }), { searchResults: [{ id: VIDEO, ie_key: 'Youtube', title: 'Found', channel: 'C', duration: 60 }, { id: 'UCchannel', ie_key: 'YoutubeTab' }] })
  const service = await start({ ytdlp, fetch: fakeYouTube(files()).fetch })
  try {
    const body = await (await service.call('/v1/search?q=never%20gonna&limit=99')).json()
    assert.deepEqual(body.results.map((result) => result.title), ['Found'])
    assert.deepEqual(ytdlp.calls.search, [{ query: 'never gonna', limit: 10 }])
    const linked = await (await service.call(`/v1/search?q=${encodeURIComponent(`https://www.youtube.com/watch?v=${VIDEO}`)}`)).json()
    assert.equal(linked.results[0].id, VIDEO)
    assert.equal(ytdlp.calls.search.length, 1)
    assert.equal((await service.call('/v1/search?q=%20')).status, 400)
  } finally { await service.close() }
})

test('thumbnails come only from i.ytimg.com, with a fallback size', async () => {
  const youtube = fakeYouTube({}, { images: { [`/vi/${VIDEO}/hqdefault.jpg`]: Buffer.from('jpeg') } })
  const service = await start({ ytdlp: fakeYtDlp(() => ({})), fetch: youtube.fetch })
  try {
    const response = await service.call(`/v1/thumbs/${VIDEO}/maxresdefault.jpg`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(await response.text(), 'jpeg')
    assert.deepEqual(youtube.requests.map((request) => request.url), [`https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`])
    assert.equal((await service.call(`/v1/thumbs/${VIDEO}/evil.jpg`)).status, 404)
  } finally { await service.close() }
})

test('too many simultaneous streams are refused instead of overloading the box', async () => {
  const fixtures = files()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const youtube = fakeYouTube(fixtures)
  const slow = async (url, init) => { if (String(url).includes('/136')) await gate; return youtube.fetch(url, init) }
  const service = await start({ ytdlp: fakeYtDlp((id) => ytdlpInfo(id, { files: files(id) })), fetch: slow, overrides: { maxStreams: 1 } })
  try {
    await service.call(`/v1/videos/${VIDEO}`)
    const first = service.call(`/v1/videos/${VIDEO}/136.mp4`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await service.call(`/v1/videos/${VIDEO}/137.mp4`)
    assert.equal(second.status, 503)
    release()
    assert.equal((await first).status, 200)
  } finally { release(); await service.close() }
})

// A real HLS client (ffmpeg) plays what the service describes: byte-range fMP4 playlists over real
// H.264/AAC fragmented MP4 files. This checks the playlists and range serving end to end; it does not
// prove Safari on an iPhone plays them (see docs/TOMTUBE.md, manual tests).
const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
test('ffmpeg plays the HLS master and audio playlists end to end', { skip: !ffmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomtube-ffmpeg-'))
  try {
    const audioPath = join(dir, 'a.m4a')
    const videoPath = join(dir, 'v.mp4')
    const flags = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof+global_sidx+cmaf']
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', '-b:a', '64k', '-frag_duration', '2000000', ...flags, audioPath]).status, 0)
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=12', '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', ...flags, videoPath]).status, 0)
    const audio = await readFile(audioPath)
    const video = await readFile(videoPath)
    const fixtures = files(VIDEO, { audio, video })
    const ytdlp = fakeYtDlp((id) => {
      const info = ytdlpInfo(id, { files: fixtures })
      info.formats = info.formats.map((format) => ({ ...format, vcodec: format.vcodec?.startsWith('avc1') ? 'avc1.42C00D' : format.vcodec }))
      return info
    })
    const service = await start({ ytdlp, fetch: fakeYouTube(fixtures).fetch, overrides: { token: '' } })
    try {
      // The service runs in this process, so the HLS client must run asynchronously.
      const run = (command, args) => promisify(execFile)(command, args, { timeout: 60_000 })
      const input = (playlist) => ['-v', 'error', '-protocol_whitelist', 'http,tcp', '-allowed_extensions', 'ALL', '-i', `${service.base}/v1/videos/${VIDEO}/${playlist}`]
      for (const playlist of ['master.m3u8', 'video.m3u8', 'audio.m3u8']) {
        await run('ffmpeg', [...input(playlist), '-map', '0', '-f', 'null', '-'])
        const probe = await run('ffprobe', [...input(playlist), '-show_entries', 'format=duration', '-of', 'csv=p=0'])
        assert.ok(Math.abs(Number(probe.stdout.trim()) - 12) < 1, `${playlist} duration ${probe.stdout}`)
      }
      // Seeking: start 8 seconds in and read to the end.
      await run('ffmpeg', ['-ss', '8', ...input('audio.m3u8'), '-f', 'null', '-'])
    } finally { await service.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
