// Adaptive streaming (HLS) for the Tomify player.
//
// The agent has ffmpeg read a track's original file straight from Navidrome and cut it into
// 6-second AAC chunks at three bitrates. The player (hls.js, or
// Safari's own HLS) picks the bitrate chunk by chunk from how fast they arrive, so
// it drops to a smaller bitrate on a weak signal and climbs back when it improves.
//
// The playlists are written by the agent from the track's length, not by ffmpeg, so
// the player can start on the first chunk while ffmpeg is still encoding the rest.
//
// A stream can also be loudness-normalised: `/v1/hls/<trackId>/<track|album>/<file>` bakes the
// track's ReplayGain (track or album gain, from Navidrome's tags) into the chunks, which is the only
// way to normalise on an iPhone. Each mode is packaged and cached separately.
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isReplayGainMode, replayGainDb } from '../shared/replaygain.mjs'

export const HLS_SEGMENT_SECONDS = 6
export const HLS_VARIANTS = Object.freeze([
  Object.freeze({ id: 'v0', bitrate: 64_000, coder: 'twoloop' }),
  Object.freeze({ id: 'v1', bitrate: 128_000, coder: 'twoloop' }),
  // ffmpeg's default AAC search is twice as slow at 256k; the fast coder is
  // transparent at this bitrate and keeps the encoder well ahead of playback.
  Object.freeze({ id: 'v2', bitrate: 256_000, coder: 'fast' }),
])

const TRACK_ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE = /^(?:master\.m3u8|(v[0-9])\/index\.m3u8|(v[0-9])\/seg(\d{5})\.ts)$/
const ENCODER_TIMEOUT_MS = 10 * 60_000
const SEGMENT_WAIT_MS = 45_000
// The current track and the pre-loaded next one; anything older is a track the listener skipped.
const MAX_ACTIVE_TRACKS = 2

export class HlsError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HlsError'
    this.status = status
    this.code = code
  }
}

export function hlsConfig(env = process.env, stateRoot = '.') {
  const enabled = String(env.TOMIFY_HLS_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  const navidromeUrl = String(env.TOMIFY_NAVIDROME_URL || 'http://127.0.0.1:4533').trim().replace(/\/+$/, '')
  const parsed = new URL(navidromeUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('TOMIFY_NAVIDROME_URL must be a plain http(s) URL.')
  const configuredMax = Number(env.TOMIFY_HLS_CACHE_MAX_BYTES || 2 * 1024 * 1024 * 1024)
  return {
    enabled,
    navidromeUrl,
    cacheDir: resolve(env.TOMIFY_HLS_CACHE_DIR || join(stateRoot, 'hls-cache')),
    maxCacheBytes: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 2 * 1024 * 1024 * 1024,
  }
}

// `/v1/hls/<trackId>/[<gain>/]<file>` → what is being asked for, or null for anything else.
// `gain` is null for the untouched stream, otherwise the ReplayGain mode baked into it.
export function parseHlsPath(pathname) {
  const match = /^\/v1\/hls\/([^/]+)\/(?:(track|album)\/)?(.+)$/.exec(String(pathname || ''))
  if (!match || !TRACK_ID.test(match[1])) return null
  const [, trackId, gainMode, name] = match
  const file = FILE.exec(name)
  if (!file) return null
  const gain = gainMode ?? null
  if (name === 'master.m3u8') return { trackId, gain, kind: 'master' }
  const variant = HLS_VARIANTS.find((candidate) => candidate.id === (file[1] || file[2]))
  if (!variant) return null
  if (file[1]) return { trackId, gain, kind: 'playlist', variant: variant.id }
  return { trackId, gain, kind: 'segment', variant: variant.id, index: Number(file[3]) }
}

// Where a stream is cached: the untouched one under the track id, a normalised one beside it.
export function hlsCacheKey(trackId, gain = null) {
  return isReplayGainMode(gain) ? `${trackId}.${gain}` : trackId
}

export function segmentName(index) { return `seg${String(index).padStart(5, '0')}.ts` }

// ffmpeg cuts at the first audio frame after each 6-second mark, so its chunks match
// these to within a frame. The count leaves out the last few milliseconds that may land
// in an extra sliver of a chunk; nobody hears that, and a playlist that promised a
// chunk ffmpeg never wrote would end the track with an error instead.
export function segmentCount(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(1, Math.ceil((duration - 0.1) / HLS_SEGMENT_SECONDS))
}

export function masterPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (const variant of HLS_VARIANTS) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(variant.bitrate * 1.1)},AVERAGE-BANDWIDTH=${variant.bitrate},CODECS="mp4a.40.2"`)
    lines.push(`${variant.id}/index.m3u8`)
  }
  return lines.join('\n') + '\n'
}

export function mediaPlaylist(duration) {
  const count = segmentCount(duration)
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${HLS_SEGMENT_SECONDS + 1}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  for (let index = 0; index < count; index += 1) {
    const length = index === count - 1 ? Math.max(0.1, duration - index * HLS_SEGMENT_SECONDS) : HLS_SEGMENT_SECONDS
    lines.push(`#EXTINF:${length.toFixed(3)},`, segmentName(index))
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

// One ffmpeg reads the track once, straight from Navidrome as it downloads, and writes all three
// bitrates. The first chunks are ready within a second or so instead of after the whole file.
// `gainDb`, when given, is the ReplayGain to bake in (already capped against clipping).
export function ffmpegHlsArguments(input, trackDir, gainDb = null) {
  const reconnect = /^https?:/.test(input) ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10'] : []
  const filter = Number.isFinite(gainDb) && gainDb !== 0 ? ['-af', `volume=${gainDb}dB`] : []
  const outputs = HLS_VARIANTS.flatMap((variant) => [
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...filter,
    '-c:a', 'aac', '-aac_coder', variant.coder, '-b:a', String(variant.bitrate), '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', String(HLS_SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_list_size', '0',
    // Chunks are written under a temporary name and renamed when finished, so a chunk that exists is complete.
    '-hls_flags', 'temp_file', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', join(trackDir, variant.id, 'seg%05d.ts'),
    join(trackDir, variant.id, 'ffmpeg.m3u8'),
  ])
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...reconnect, '-i', input, ...outputs]
}

export function navidromeSourceUrl(baseUrl, trackId, credentials, endpoint = 'stream') {
  const url = new URL(`${baseUrl}/rest/${endpoint}.view`)
  url.searchParams.set('id', trackId)
  url.searchParams.set('u', credentials.user)
  url.searchParams.set('t', credentials.token)
  url.searchParams.set('s', credentials.salt)
  url.searchParams.set('v', '1.16.1')
  url.searchParams.set('c', 'Tomify-HLS')
  if (endpoint === 'stream') url.searchParams.set('format', 'raw')
  else url.searchParams.set('f', 'json')
  return url
}

export function credentialsFromHeaders(headers) {
  const user = String(headers['x-tomify-navidrome-user'] || '')
  const token = String(headers['x-tomify-navidrome-token'] || '')
  const salt = String(headers['x-tomify-navidrome-salt'] || '')
  if (!user || !/^[a-f0-9]{32}$/i.test(token) || !/^[A-Za-z0-9]{1,64}$/.test(salt)) return null
  return { user, token, salt, origin: publicNavidromeOrigin(headers['x-tomify-navidrome-origin']) }
}

// The Worker also says where it reaches Navidrome (the public tunnel). The agent uses that only
// when Navidrome can't be reached on the box itself, for example when it runs in Docker without
// a published port.
export function publicNavidromeOrigin(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch { return null }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const exists = (path) => stat(path).then(() => true, () => false)

async function directorySize(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else total += (await stat(child).catch(() => ({ size: 0 }))).size
  }
  return total
}

export function createHlsPackager({ config, ffmpeg = 'ffmpeg', probeDuration, fetch: fetcher = globalThis.fetch, spawn = nodeSpawn, log = () => {}, now = Date.now }) {
  const jobs = new Map()
  const deciding = new Map()

  function trackDir(key) { return join(config.cacheDir, key) }

  // Navidrome on the box first; the public origin only when the box's address refuses the connection.
  let reachableBase = null
  async function navidromeFetch(trackId, credentials, endpoint) {
    const bases = [...new Set([reachableBase, config.navidromeUrl, credentials.origin].filter(Boolean))]
    let failure
    for (const base of bases) {
      try {
        const response = await fetcher(navidromeSourceUrl(base, trackId, credentials, endpoint))
        reachableBase = base
        return response
      } catch (error) { failure = error }
    }
    throw new HlsError(502, 'navidrome-unreachable', `Navidrome could not be reached (${failure instanceof Error ? failure.message : 'no address'}). Set TOMIFY_NAVIDROME_URL.`)
  }

  // Navidrome's own record of the track: its size tells a replaced file apart, its length is the
  // fallback when ffprobe can't read one from the stream.
  async function songInfo(trackId, credentials) {
    const response = await navidromeFetch(trackId, credentials, 'getSong')
    const body = await response.json().catch(() => null)
    const song = body?.['subsonic-response']?.song
    if (!response.ok || !song) throw new HlsError(response.status === 401 || response.status === 403 ? 401 : 404, 'source-unavailable', 'The music server did not return this track.')
    return { size: Number(song.size) || null, duration: Number(song.duration) || null, replayGain: song.replayGain ?? null }
  }

  function encode(job, input) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(ffmpeg, ffmpegHlsArguments(input, job.dir, job.gainDb), { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      job.children.add(child)
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), ENCODER_TIMEOUT_MS)
      timer.unref?.()
      child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
      child.on('error', (error) => { clearTimeout(timer); job.children.delete(child); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        job.children.delete(child)
        if (code === 0) resolvePromise()
        else reject(new Error(`ffmpeg failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`))
      })
    })
  }

  async function start({ trackId, gain, key }, credentials, sourceInfo) {
    const dir = trackDir(key)
    const job = { trackId, key, dir, duration: null, gainDb: null, done: false, failed: null, cancelled: false, children: new Set(), lastUsed: now(), ready: null, finished: null }
    jobs.set(key, job)
    await stopSkippedJobs(key)
    job.ready = (async () => {
      await rm(dir, { recursive: true, force: true })
      for (const variant of HLS_VARIANTS) await mkdir(join(dir, variant.id), { recursive: true })
      const info = sourceInfo ?? await songInfo(trackId, credentials)
      job.size = info.size
      // An untagged track in a normalised mode is packaged as it is.
      job.gainDb = gain ? replayGainDb(info.replayGain, gain) : null
      const source = navidromeSourceUrl(reachableBase ?? config.navidromeUrl, trackId, credentials).toString()
      // ffprobe reads only the start of the stream; Navidrome's whole-second length is the fallback.
      const probed = Number(await probeDuration(source).catch(() => null))
      const duration = Number.isFinite(probed) && probed > 0 ? probed : info.duration
      if (!Number.isFinite(duration) || duration <= 0) throw new HlsError(415, 'unreadable-source', 'This track could not be read for streaming.')
      job.duration = duration
      await writeFile(join(dir, 'info.json'), JSON.stringify({ trackId, gain, gainDb: job.gainDb, duration, size: info.size, complete: false }))
      return source
    })()
    job.finished = job.ready.then(async (source) => {
      await encode(job, source)
      if (job.cancelled) return
      await writeFile(join(dir, 'info.json'), JSON.stringify({ trackId, gain, gainDb: job.gainDb, duration: job.duration, size: job.size, complete: true }))
      job.done = true
    }).catch(async (error) => {
      job.failed = error
      for (const child of job.children) child.kill('SIGKILL')
      // A skipped track's folder is left for the next packaging of it (which clears it first) or the cache limit.
      if (job.cancelled) return
      log(`HLS packaging failed for ${key}: ${error instanceof Error ? error.message : error}`)
      if (jobs.get(key) === job) jobs.delete(key)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }).finally(() => {
      if (jobs.get(key) === job && job.done) jobs.delete(key)
      void prune().catch(() => undefined)
    })
    job.ready.catch(() => undefined)
    return job
  }

  async function stopSkippedJobs(keepKey) {
    const running = [...jobs.values()].filter((job) => !job.done && !job.failed && job.key !== keepKey).sort((left, right) => right.lastUsed - left.lastUsed)
    for (const job of running.slice(MAX_ACTIVE_TRACKS - 1)) {
      job.cancelled = true
      job.failed = new HlsError(410, 'cancelled', 'Packaging was stopped because the track was skipped.')
      for (const child of job.children) child.kill('SIGKILL')
      jobs.delete(job.key)
    }
  }

  // Oldest-used tracks go first once the cache is over its limit; tracks being packaged stay.
  // One prune at a time: two overlapping ones each count the whole cache, and the second
  // can delete the newest track after the first already brought the cache under its limit.
  let pruning = Promise.resolve()
  function prune() {
    const run = pruning.then(pruneOnce, pruneOnce)
    pruning = run.catch(() => undefined)
    return run
  }

  async function pruneOnce() {
    const entries = []
    let total = 0
    for (const entry of await readdir(config.cacheDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || jobs.has(entry.name)) continue
      const path = join(config.cacheDir, entry.name)
      const size = await directorySize(path)
      const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: 0 }))
      entries.push({ path, size, mtimeMs })
      total += size
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const entry of entries) {
      if (total <= config.maxCacheBytes) break
      await rm(entry.path, { recursive: true, force: true }).catch(() => undefined)
      total -= entry.size
    }
  }

  async function cached(key) {
    try {
      const info = JSON.parse(await readFile(join(trackDir(key), 'info.json'), 'utf8'))
      return info?.complete === true && Number.isFinite(info.duration) ? info : null
    } catch { return null }
  }

  async function touch(key) {
    const time = new Date(now())
    await utimes(trackDir(key), time, time).catch(() => undefined)
  }

  // Returns a finished or running packaging of the track. A finished one is reused unless the
  // music server now reports a different file size (the file was replaced since).
  function obtain(target, credentials, options = {}) {
    // Requests for one track arrive together (playlist and first chunks); only one may start the packaging.
    const pending = deciding.get(target.key)
    if (pending) return pending.then(() => obtain(target, credentials, options))
    const decision = decide(target, credentials, options)
    const settled = decision.then(() => undefined, () => undefined)
    deciding.set(target.key, settled)
    void settled.then(() => { if (deciding.get(target.key) === settled) deciding.delete(target.key) })
    return decision
  }

  async function decide(target, credentials, { checkSource = false } = {}) {
    const running = jobs.get(target.key)
    if (running) {
      running.lastUsed = now()
      await running.ready
      return { duration: running.duration, job: running }
    }
    const info = await cached(target.key)
    const latest = info && checkSource ? await songInfo(target.trackId, credentials).catch(() => null) : null
    // Retagging a file changes its size too, so a normalised stream follows new ReplayGain tags.
    if (info && (!latest || latest.size === null || info.size === null || latest.size === info.size)) {
      await touch(target.key)
      return { duration: info.duration, job: null }
    }
    // A track left half-packaged by an agent restart is started again from scratch.
    const job = await start(target, credentials, latest)
    await job.ready
    return { duration: job.duration, job }
  }

  async function waitForSegment(path, job) {
    const deadline = now() + SEGMENT_WAIT_MS
    for (;;) {
      if (await exists(path)) return true
      if (!job || job.done) return exists(path)
      if (job.failed) throw job.failed
      if (now() > deadline) throw new HlsError(504, 'segment-timeout', 'The chunk took too long to encode.')
      await sleep(100)
    }
  }

  async function handle(request, credentials) {
    if (!config.enabled) throw new HlsError(503, 'hls-disabled', 'Adaptive streaming is turned off on the agent.')
    const target = { trackId: request.trackId, gain: request.gain ?? null, key: hlsCacheKey(request.trackId, request.gain) }
    if (request.kind === 'master') {
      await obtain(target, credentials, { checkSource: true })
      return { contentType: 'application/vnd.apple.mpegurl', body: masterPlaylist() }
    }
    const { duration, job } = await obtain(target, credentials)
    if (request.kind === 'playlist') return { contentType: 'application/vnd.apple.mpegurl', body: mediaPlaylist(duration) }
    if (request.index >= segmentCount(duration)) throw new HlsError(404, 'not-found', 'No such chunk.')
    const path = join(trackDir(target.key), request.variant, segmentName(request.index))
    if (!await waitForSegment(path, job)) throw new HlsError(404, 'not-found', 'No such chunk.')
    return { contentType: 'video/mp2t', filePath: path }
  }

  return { handle, prune, jobs }
}
