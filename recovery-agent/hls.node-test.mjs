import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHlsPackager, credentialsFromHeaders, ffmpegHlsArguments, hlsConfig, HLS_VARIANTS, masterPlaylist, mediaPlaylist, navidromeSourceUrl, parseHlsPath, segmentCount, segmentName } from './hls.mjs'

const credentials = { user: 'tom', token: 'a'.repeat(32), salt: 'abc123' }

test('parseHlsPath accepts only the playlist and chunk names the agent writes', () => {
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/master.m3u8'), { trackId: 'abc123', kind: 'master' })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/v1/index.m3u8'), { trackId: 'abc123', kind: 'playlist', variant: 'v1' })
  assert.deepEqual(parseHlsPath('/v1/hls/abc123/v2/seg00012.ts'), { trackId: 'abc123', kind: 'segment', variant: 'v2', index: 12 })
  for (const bad of ['/v1/hls/../master.m3u8', '/v1/hls/abc/v9/index.m3u8', '/v1/hls/abc/v1/../../x.ts', '/v1/hls/abc/source', '/v1/hls/a%2Fb/master.m3u8', '/v1/hls/abc/v1/seg1.ts', '/v1/status']) {
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

test('ffmpeg arguments encode one AAC variant into renamed-on-finish chunks', () => {
  const args = ffmpegHlsArguments('/cache/t/source', '/cache/t/v0', HLS_VARIANTS[0])
  assert.deepEqual(args.slice(args.indexOf('-b:a'), args.indexOf('-b:a') + 2), ['-b:a', '64000'])
  assert.ok(args.includes('temp_file'))
  assert.equal(args.at(-1), '/cache/t/v0/ffmpeg.m3u8')
  assert.ok(args.includes('/cache/t/v0/seg%05d.ts'))
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
  assert.equal(config.cacheDir, '/var/lib/tomify-recovery/hls-cache')
  assert.equal(config.enabled, true)
  assert.equal(hlsConfig({ TOMIFY_HLS_ENABLED: 'false' }, '/x').enabled, false)
  assert.throws(() => hlsConfig({ TOMIFY_NAVIDROME_URL: 'http://user:pw@host' }, '/x'))
})

// A stand-in ffmpeg that writes `chunks` chunk files, one every `delayMs`.
function fakeSpawn({ chunks = 3, delayMs = 5, fail = false } = {}) {
  const calls = []
  const spawn = (command, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    calls.push({ command, args, child })
    const pattern = args[args.indexOf('-hls_segment_filename') + 1]
    void (async () => {
      for (let index = 0; index < chunks; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (child.killed) { child.emit('close', null); return }
        try { await writeFile(pattern.replace('%05d', String(index).padStart(5, '0')), `chunk ${index}`) }
        catch { child.emit('close', 1); return }
      }
      if (fail) child.stderr.emit('data', 'boom')
      child.emit('close', fail ? 1 : 0)
    })()
    return child
  }
  return { spawn, calls }
}

function fakeNavidrome({ size = 11, body = 'flac source' } = {}) {
  const requests = []
  const fetch = async (url) => {
    requests.push(String(url))
    if (url.pathname.endsWith('/getSong.view')) return Response.json({ 'subsonic-response': { status: 'ok', song: { size, suffix: 'flac' } } })
    return new Response(body, { headers: { 'content-type': 'audio/flac' } })
  }
  return { fetch, requests }
}

async function packager(options = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'tomify-hls-test-'))
  const navidrome = options.navidrome ?? fakeNavidrome()
  const ffmpeg = options.ffmpeg ?? fakeSpawn()
  const hls = createHlsPackager({ config: { enabled: true, navidromeUrl: 'http://navidrome', cacheDir, maxCacheBytes: options.maxCacheBytes ?? 1e9 }, probeDuration: async () => options.duration ?? 15, fetch: navidrome.fetch, spawn: ffmpeg.spawn })
  return { hls, cacheDir, navidrome, ffmpeg }
}

test('a track is packaged once and its chunks are served as they are written', async () => {
  const { hls, cacheDir, navidrome, ffmpeg } = await packager()
  const [master, playlist, first] = await Promise.all([
    hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials),
    hls.handle(parseHlsPath('/v1/hls/t1/v1/index.m3u8'), credentials),
    hls.handle(parseHlsPath('/v1/hls/t1/v0/seg00000.ts'), credentials),
  ])
  assert.equal(master.body, masterPlaylist())
  assert.equal(playlist.body, mediaPlaylist(15))
  assert.equal(await readFile(first.filePath, 'utf8'), 'chunk 0')
  assert.equal(ffmpeg.calls.length, HLS_VARIANTS.length, 'one encoder per variant, started once')
  assert.equal(navidrome.requests.filter((url) => url.includes('/stream.view')).length, 1)
  const last = await hls.handle(parseHlsPath('/v1/hls/t1/v2/seg00002.ts'), credentials)
  assert.equal(await readFile(last.filePath, 'utf8'), 'chunk 2')
  await assert.rejects(hls.handle(parseHlsPath('/v1/hls/t1/v2/seg00003.ts'), credentials), { status: 404 })
  // Wait for the packaging to finish, then a later request reuses it without fetching or encoding again.
  while (hls.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5))
  const info = JSON.parse(await readFile(join(cacheDir, 't1', 'info.json'), 'utf8'))
  assert.equal(info.complete, true)
  await assert.rejects(stat(join(cacheDir, 't1', 'source')), 'the downloaded original is removed once encoded')
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  assert.equal(ffmpeg.calls.length, HLS_VARIANTS.length)
  await rm(cacheDir, { recursive: true, force: true })
})

test('a cached track is packaged again when Navidrome reports a different file size', async () => {
  let size = 11
  const navidrome = fakeNavidrome()
  const fetch = async (url) => url.pathname.endsWith('/getSong.view') ? Response.json({ 'subsonic-response': { status: 'ok', song: { size } } }) : navidrome.fetch(url)
  const { hls, cacheDir, ffmpeg } = await packager({ navidrome: { fetch, requests: [] } })
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  while (hls.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5))
  size = 99
  await hls.handle(parseHlsPath('/v1/hls/t1/master.m3u8'), credentials)
  assert.equal(ffmpeg.calls.length, HLS_VARIANTS.length * 2)
  await rm(cacheDir, { recursive: true, force: true })
})

test('a Subsonic error instead of audio is reported, not packaged', async () => {
  const fetch = async (url) => url.pathname.endsWith('/getSong.view') ? Response.json({ 'subsonic-response': { status: 'failed' } }) : Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70 } } })
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
  const killed = ffmpeg.calls.filter((call) => call.child.killed).map((call) => call.args.at(-1).split('/').at(-3))
  assert.deepEqual([...new Set(killed)], ['a'])
  assert.deepEqual([...hls.jobs.keys()].sort(), ['b', 'c'])
  for (const call of ffmpeg.calls) call.child.kill()
  await rm(cacheDir, { recursive: true, force: true })
})

test('the cache drops the least recently played tracks once it is over its limit', async () => {
  const { hls, cacheDir } = await packager({ maxCacheBytes: 200 })
  for (const id of ['old', 'new']) {
    await hls.handle(parseHlsPath(`/v1/hls/${id}/master.m3u8`), credentials)
    while (hls.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await hls.prune()
  assert.deepEqual(await readdir(cacheDir), ['new'])
  await rm(cacheDir, { recursive: true, force: true })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
test('real ffmpeg produces exactly the chunks the playlist lists', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'tomify-hls-ffmpeg-'))
  const source = join(work, 'tone.flac')
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20.5:sample_rate=44100', '-ac', '2', source]).status, 0)
  const audio = await readFile(source)
  const { hls, cacheDir } = await packager({
    duration: 20.5,
    navidrome: { fetch: async (url) => url.pathname.endsWith('/getSong.view') ? Response.json({}) : new Response(audio, { headers: { 'content-type': 'audio/flac' } }) },
    ffmpeg: { spawn: (await import('node:child_process')).spawn },
  })
  const playlist = (await hls.handle(parseHlsPath('/v1/hls/tone/v0/index.m3u8'), credentials)).body
  const listed = playlist.match(/seg\d+\.ts/g)
  for (const name of listed) {
    const chunk = await hls.handle(parseHlsPath(`/v1/hls/tone/v0/${name}`), credentials)
    assert.ok((await stat(chunk.filePath)).size > 1000, name)
  }
  while (hls.jobs.size) await new Promise((resolve) => setTimeout(resolve, 20))
  const written = (await readdir(join(cacheDir, 'tone', 'v0'))).filter((name) => name.endsWith('.ts'))
  assert.ok(written.length >= listed.length && written.length <= listed.length + 1, `${written.length} written, ${listed.length} listed`)
  assert.equal(listed.at(-1), segmentName(listed.length - 1))
  await rm(work, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})
