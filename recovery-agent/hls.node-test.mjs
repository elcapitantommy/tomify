import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHlsPackager, credentialsFromHeaders, ffmpegHlsArguments, hlsCacheKey, hlsConfig, HLS_VARIANTS, masterPlaylist, mediaPlaylist, navidromeSourceUrl, parseHlsPath, segmentCount, segmentName } from './hls.mjs'

const credentials = { user: 'tom', token: 'a'.repeat(32), salt: 'abc123' }

test('parseHlsPath accepts only the playlist and chunk names the agent writes', () => {
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/master.m3u8'), { trackId: 'abc123', gain: null, kind: 'master' })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/v1/index.m3u8'), { trackId: 'abc123', gain: null, kind: 'playlist', variant: 'v1' })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/v2/seg00012.ts'), { trackId: 'abc123', gain: null, kind: 'segment', variant: 'v2', index: 12 })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/album/master.m3u8'), { trackId: 'abc123', gain: 'album', kind: 'master' })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/track/v0/seg00001.ts'), { trackId: 'abc123', gain: 'track', kind: 'segment', variant: 'v0', index: 1 })
  for (const bad of ['/v1/hls/abc/loud/master.m3u8', '/v1/hls/abc/album/album/master.m3u8', '/v1/hls/abc/album/source', '/v1/hls/../master.m3u8', '/v1/hls/abc/v9/index.m3u8', '/v1/hls/abc/v1/../../x.ts', '/v1/hls/abc/source', '/v1/hls/a%2Fb/master.m3u8', '/v1/hls/abc/v1/seg1.ts', '/v1/status']) {
    assert.equal(parseHlsPath(bad), null, bad)
  }
})

test('playlists list every variant and a chunk per 6 seconds without promising a trailing sliver', () => {
  const master = masterPlaylist()
  for (const variant of HLS_VARIANTS) assert.match(master, new RegExp(`AVERAGE-BANDWIDTH=${variant.bitrate},CODECS="mp4a.40.2"\\n${variant.id}/index.m3u8`))
  assert.equal(segmentCount(240), 40)
  assert.equal(segmentCount(240.05), 40)
  assert.equal(segmentCount(241), 41)
  assert.equal(segmentCount(3), 1)
  assert.equal(segmentCount(0), 0)
  const media = mediaPlaylist(15)
  assert.match(media, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.deepEqual(media.match(/seg\d+\.ts/g), ['seg00000.ts', 'seg00001.ts', 'seg00002.ts'])
  assert.match(media, /#EXTINF:3\.000,\nseg00002\.ts\n#EXT-X-ENDLIST/)
})

test('one ffmpeg reads the track once and writes every bitrate into renamed-on-finish chunks', () => {
  const args = ffmpegHlsArguments('http://navidrome/rest/stream.view?id=t', '/cache/t')
  assert.equal(args.filter((arg) => arg === '-i').length, 1)
  assert.ok(args.includes('-reconnect'))
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-b:a'), ['64000', '128000', '256000'])
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-hls_segment_filename'), ['v0', 'v1', 'v2'].map((variant) => join('/cache/t', variant, 'seg%05d.ts')))
  assert.equal(args.filter((arg) => arg === 'temp_file').length, 3)
  assert.equal(args.at(-1), join('/cache/t', 'v2', 'ffmpeg.m3u8'))
  assert.ok(!ffmpegHlsArguments('/cache/t/source', '/cache/t').includes('-reconnect'))
})

test('a normalised stream bakes its gain into every bitrate and is cached apart from the untouched one', () => {
  const args = ffmpegHlsArguments('/cache/t.album/source', '/cache/t.album', -7.25)
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-af'), ['volume=-7.25dB', 'volume=-7.25dB', 'volume=-7.25dB'])
  assert.ok(!ffmpegHlsArguments('/s', '/c', null).includes('-af'))
  assert.ok(!ffmpegHlsArguments('/s', '/c', 0).includes('-af'))
  assert.equal(hlsCacheKey('t1'), 't1')
  assert.equal(hlsCacheKey('t1', 'album'), 't1.album')
  assert.equal(hlsCacheKey('t1', 'loud'), 't1')
})

test('the source is fetched from Navidrome untranscoded with the listener’s login', () => {
  const url = navidromeSourceUrl('http://127.0.0.1:4533', 'abc', credentials)
  assert.equal(url.pathname, '/rest/stream.view')
  assert.equal(url.searchParams.get('format'), 'raw')
  assert.equal(url.searchParams.get('u'), 'tom')
  assert.equal(credentialsFromHeaders({ 'x-tomify-navidrome-user': 'tom', 'x-tomify-navidrome-token': credentials.token, 'x-tomify-navidrome-salt': 'abc123' }).user, 'tom')
  assert.equal(credentialsFromHeaders({ 'x-tomify-navidrome-user': 'tom', 'x-tomify-navidrome-token': 'nope', 'x-tomify-navidrome-salt': 'abc123' }), null)
})

test('hlsConfig defaults to Navidrome on the box and a cache under the state folder', () => {
  const config = hlsConfig({}, '/var/lib/tomify-recovery')
  assert.equal(config.navidromeUrl, 'http://127.0.0.1:4533')
  assert.equal(config.cacheDir, resolve('/var/lib/tomify-recovery', 'hls-cache'))
  assert.equal(config.enabled, true)
  assert.equal(hlsConfig({ TOMIFY_HLS_ENABLED: 'false' }, '/x').enabled, false)
  assert.throws(() => hlsConfig({ TOMIFY_NAVIDROME_URL: 'http://user:pw@host' }, '/x'))
})

// A stand-in ffmpeg that writes `chunks` chunk files for every bitrate, one every `delayMs`.
function fakeSpawn({ chunks = 3, delayMs = 5, fail = false } = {}) {
  const calls = []
  const spawn = (command, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    calls.push({ command, args, child, input: args[args.indexOf('-i') + 1] })
    const patterns = args.filter((_, index) => args[index - 1] === '-hls_segment_filename')
    void (async () => {
      for (let index = 0; index < chunks; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (child.killed) { child.emit('close', null); return }
        try { for (const pattern of patterns) await writeFile(pattern.replace('%05d', String(index).padStart(5, '0')), `chunk ${index}`) }
        catch { child.emit('close', 1); return }
      }
      if (fail) child.stderr.emit('data', 'boom')
      child.emit('close', fail ? 1 : 0)
    })()
    return child
  }
  return { spawn, calls }
}

function fakeNavidrome({ size = 11, duration = 15, replayGain } = {}) {
  const requests = []
  const fetch = async (url) => {
    requests.push(String(url))
    if (url.pathname.endsWith('/getSong.view')) return Response.json({ 'subsonic-response': { status: 'ok', song: { size, duration, suffix: 'flac', ...(replayGain ? { replayGain } : {}) } } })
    return new Response('unexpected', { status: 500 })
  }
  return { fetch, requests }
}

async function packager(options = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'tomify-hls-test-'))
  const navidrome = options.navidrome ?? fakeNavidrome()
  const ffmpeg = options.ffmpeg ?? fakeSpawn()
  const probeDuration = options.probeDuration ?? (async () => options.duration ?? 15)
  const hls = createHlsPackager({ config: { enabled: true, navidromeUrl: options.navidromeUrl ?? 'http://navidrome', cacheDir, maxCacheBytes: options.maxCacheBytes ?? 1e9 }, probeDuration, fetch: navidrome.fetch, spawn: ffmpeg.spawn })
  return { hls, cacheDir, navidrome, ffmpeg }
}

const settle = async (hls) => { while (hls.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5)) }

test('a track is packaged once, streamed from Navidrome, and its chunks are served as they are written', async () => {
  const { hls, cacheDir, ffmpeg } = await packager()
  const [master, playlist, first] = await Promise.all([
    hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials),
    hls.handle(parseHlsPath('/v1/hls/t1/v1/index.m3u8'), credentials),
    hls.handle(parseHlsPath('/v1/hls/t1/v0/seg00000.ts'), credentials),
  ])
  assert.equal(master.body, masterPlaylist())
  assert.equal(playlist.body, mediaPlaylist(15))
  assert.equal(await readFile(first.filePath, 'utf8'), 'chunk 0')
  assert.equal(ffmpeg.calls.length, 1, 'one encoder for all bitrates, started once')
  const input = new URL(ffmpeg.calls[0].input)
  assert.equal(input.origin + input.pathname, 'http://navidrome/rest/stream.view')
  assert.equal(input.searchParams.get('format'), 'raw')
  const last = await hls.handle(parseHlsPath('/v1/hls/t1/v2/seg00002.ts'), credentials)
  assert.equal(await readFile(last.filePath, 'utf8'), 'chunk 2')
  await assert.rejects(hls.handle(parseHlsPath('/v1/hls/t1/v2/seg00003.ts'), credentials), { status: 404 })
  await settle(hls)
  assert.equal(JSON.parse(await readFile(join(cacheDir, 't1', 'info.json'), 'utf8')).complete, true)
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  assert.equal(ffmpeg.calls.length, 1)
  await rm(cacheDir, { recursive: true, force: true })
})

test('Navidrome’s own length is used when ffprobe can’t read one from the stream', async () => {
  const { hls, cacheDir } = await packager({ navidrome: fakeNavidrome({ duration: 21 }), probeDuration: async () => { throw new Error('ffprobe failed') } })
  assert.equal((await hls.handle(parseHlsPath('/v1/hls/t1/v0/index.m3u8'), credentials)).body, mediaPlaylist(21))
  await settle(hls)
  await rm(cacheDir, { recursive: true, force: true })
})

test('each gain mode is packaged once with the track’s ReplayGain, beside the untouched stream', async () => {
  const navidrome = fakeNavidrome({ replayGain: { trackGain: -9.1, trackPeak: 0.98, albumGain: -8.4, albumPeak: 0.99 } })
  const { hls, cacheDir, ffmpeg } = await packager({ navidrome })
  for (const path of ['/v1/hls/t1/master.m3u8', '/v1/hls/t1/album/master.m3u8', '/v1/hls/t1/track/master.m3u8', '/v1/hls/t1/album/v1/index.m3u8']) await hls.handle(parseHlsPath(path), credentials)
  const chunk = await hls.handle(parseHlsPath('/v1/hls/t1/album/v0/seg00000.ts'), credentials)
  assert.equal(chunk.filePath, join(cacheDir, 't1.album', 'v0', 'seg00000.ts'))
  await settle(hls)
  assert.deepEqual(ffmpeg.calls.map((call) => call.args.filter((_, index) => call.args[index - 1] === '-af')[0] ?? null), [null, 'volume=-8.4dB', 'volume=-9.1dB'])
  assert.deepEqual((await readdir(cacheDir)).sort(), ['t1', 't1.album', 't1.track'])
  assert.equal(JSON.parse(await readFile(join(cacheDir, 't1.album', 'info.json'), 'utf8')).gainDb, -8.4)
  await rm(cacheDir, { recursive: true, force: true })
})

test('an untagged track in a normalised mode is packaged as it is', async () => {
  const { hls, cacheDir, ffmpeg } = await packager()
  await hls.handle(parseHlsPath('/v1/hls/t1/track/master.m3u8'), credentials)
  await settle(hls)
  assert.ok(!ffmpeg.calls[0].args.includes('-af'))
  await rm(cacheDir, { recursive: true, force: true })
})

test('a cached track is packaged again when Navidrome reports a different file size', async () => {
  let size = 11
  const fetch = async () => Response.json({ 'subsonic-response': { status: 'ok', song: { size, duration: 15 } } })
  const { hls, cacheDir, ffmpeg } = await packager({ navidrome: { fetch } })
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  await settle(hls)
  size = 99
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  assert.equal(ffmpeg.calls.length, 2)
  await settle(hls)
  await rm(cacheDir, { recursive: true, force: true })
})

test('a track Navidrome doesn’t know is reported, not packaged', async () => {
  const fetch = async () => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70 } } })
  const { hls, cacheDir, ffmpeg } = await packager({ navidrome: { fetch } })
  await assert.rejects(hls.handle(parseHlsPath('/v1/hls/missing/master.m3u8'), credentials), { code: 'source-unavailable' })
  assert.equal(ffmpeg.calls.length, 0)
  assert.equal(hls.jobs.size, 0)
  await rm(cacheDir, { recursive: true, force: true })
})

test('skipping through tracks stops the encoders of tracks nobody is listening to', async () => {
  const ffmpeg = fakeSpawn({ chunks: 1000, delayMs: 20 })
  const { hls, cacheDir } = await packager({ ffmpeg })
  for (const id of ['a', 'b', 'c']) await hls.handle(parseHlsPath(`/v1/hls/${id}/master.m3u8`), credentials)
  const killed = ffmpeg.calls.filter((call) => call.child.killed).map((call) => new URL(call.input).searchParams.get('id'))
  assert.deepEqual(killed, ['a'])
  assert.deepEqual([...hls.jobs.keys()].sort(), ['b', 'c'])
  for (const call of ffmpeg.calls) call.child.kill()
  await rm(cacheDir, { recursive: true, force: true })
})

test('the cache drops the least recently played tracks once it is over its limit', async () => {
  const { hls, cacheDir } = await packager({ maxCacheBytes: 200 })
  for (const id of ['old', 'new']) {
    await hls.handle(parseHlsPath(`/v1/hls/${id}/master.m3u8`), credentials)
    await settle(hls)
  }
  await hls.prune()
  assert.deepEqual(await readdir(cacheDir), ['new'])
  await rm(cacheDir, { recursive: true, force: true })
})

test('overlapping cache prunes never delete more than they need to', async () => {
  for (let round = 0; round < 10; round += 1) {
    const { hls, cacheDir } = await packager({ maxCacheBytes: 200 })
    for (const id of ['old', 'new']) {
      await hls.handle(parseHlsPath(`/v1/hls/${id}/master.m3u8`), credentials)
      await settle(hls)
    }
    await Promise.all([hls.prune(), hls.prune(), hls.prune()])
    assert.deepEqual(await readdir(cacheDir), ['new'])
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('Navidrome is reached through the public origin when the box address refuses the connection', async () => {
  const seen = []
  const navidrome = fakeNavidrome()
  const fetch = async (url) => {
    seen.push(url.origin)
    if (url.origin === 'http://navidrome') throw new TypeError('fetch failed: connect ECONNREFUSED')
    return navidrome.fetch(url)
  }
  const { hls, cacheDir, ffmpeg } = await packager({ navidrome: { fetch } })
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), { ...credentials, origin: 'https://music.example' })
  assert.deepEqual(seen, ['http://navidrome', 'https://music.example'])
  assert.equal(new URL(ffmpeg.calls[0].input).origin, 'https://music.example')
  await settle(hls)
  const other = (await packager({ navidrome: { fetch } })).hls
  await assert.rejects(other.handle(parseHlsPath('/v1/hls/t2/master.m3u8'), credentials), { code: 'navidrome-unreachable' })
  const headers = { 'x-tomify-navidrome-user': 'tom', 'x-tomify-navidrome-token': credentials.token, 'x-tomify-navidrome-salt': 'abc123' }
  assert.equal(credentialsFromHeaders({ ...headers, 'x-tomify-navidrome-origin': 'http://evil.test' }).origin, null)
  assert.equal(credentialsFromHeaders({ ...headers, 'x-tomify-navidrome-origin': 'https://music.example' }).origin, 'https://music.example')
  await rm(cacheDir, { recursive: true, force: true })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0
test('real ffmpeg streams from an HTTP source and produces the chunks the playlist lists', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'tomify-hls-ffmpeg-'))
  const source = join(work, 'tone.flac')
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20.5:sample_rate=44100', '-ac', '2', source]).status, 0)
  const audio = await readFile(source)
  const server = createServer((request, response) => {
    if (request.url.startsWith('/rest/getSong.view')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', song: { size: audio.length, duration: 20 } } })) }
    response.writeHead(200, { 'content-type': 'audio/flac', 'content-length': audio.length })
    response.end(audio)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  // Asynchronous, so the test's own HTTP server can answer ffprobe.
  const probeDuration = async (url) => Number((await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', url])).stdout)
  const { hls, cacheDir } = await packager({ navidromeUrl: base, navidrome: { fetch: globalThis.fetch }, ffmpeg: { spawn: (await import('node:child_process')).spawn }, probeDuration })
  try {
    const playlist = (await hls.handle(parseHlsPath('/v1/hls/tone/v0/index.m3u8'), credentials)).body
    assert.match(playlist, /#EXTINF:2\.500,\nseg00003\.ts\n#EXT-X-ENDLIST/)
    const listed = playlist.match(/seg\d+\.ts/g)
    for (const variant of HLS_VARIANTS) {
      for (const name of listed) {
        const chunk = await hls.handle(parseHlsPath(`/v1/hls/tone/${variant.id}/${name}`), credentials)
        assert.ok((await stat(chunk.filePath)).size > 1000, `${variant.id}/${name}`)
      }
    }
    await settle(hls)
    const written = (await readdir(join(cacheDir, 'tone', 'v0'))).filter((name) => name.endsWith('.ts'))
    assert.ok(written.length >= listed.length && written.length <= listed.length + 1, `${written.length} written, ${listed.length} listed`)
  } finally {
    server.close()
    await rm(work, { recursive: true, force: true })
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('real ffmpeg lowers a normalised stream by the track’s ReplayGain', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'tomify-hls-gain-'))
  const source = join(work, 'tone.flac')
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7:sample_rate=44100', '-ac', '2', source]).status, 0)
  const audio = await readFile(source)
  const server = createServer((request, response) => {
    if (request.url.startsWith('/rest/getSong.view')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', song: { size: audio.length, duration: 7, replayGain: { trackGain: -12, trackPeak: 0.125 } } } })) }
    response.writeHead(200, { 'content-type': 'audio/flac', 'content-length': audio.length })
    response.end(audio)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const probeDuration = async (url) => Number((await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', url])).stdout)
  const meanVolume = async (path) => Number(/mean_volume: (-?[\d.]+) dB/.exec((await promisify(execFile)('ffmpeg', ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'])).stderr)[1])
  const { hls, cacheDir } = await packager({ navidromeUrl: base, navidrome: { fetch: globalThis.fetch }, ffmpeg: { spawn: (await import('node:child_process')).spawn }, probeDuration })
  try {
    const plain = await hls.handle(parseHlsPath('/v1/hls/tone/v2/seg00000.ts'), credentials)
    const normalised = await hls.handle(parseHlsPath('/v1/hls/tone/track/v2/seg00000.ts'), credentials)
    await settle(hls)
    const difference = (await meanVolume(plain.filePath)) - (await meanVolume(normalised.filePath))
    assert.ok(Math.abs(difference - 12) < 0.5, `${difference} dB quieter`)
  } finally {
    server.close()
    await rm(work, { recursive: true, force: true })
    await rm(cacheDir, { recursive: true, force: true })
  }
})
