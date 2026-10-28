// TomTube's HTTP API. It listens on loopback only; the Cloudflare Worker reaches it through the
// Cloudflare Tunnel with a bearer token, after checking the listener's Tomify (Navidrome) sign-in.
//
//   GET  /health                               liveness, no token
//   GET  /v1/status                            diagnostics: yt-dlp version, caches, recent failures
//   GET  /v1/search?q=…                        YouTube search (yt-dlp ytsearch)
//   GET  /v1/resolve?url=…                     a pasted YouTube link → the video's details
//   GET  /v1/videos/<id>                       details and the iPhone-playable formats
//   GET  /v1/videos/<id>/master.m3u8           HLS: H.264 video up to 1080p + AAC audio
//   GET  /v1/videos/<id>/audio.m3u8            HLS: AAC audio only (background playback)
//   GET  /v1/videos/<id>/v<itag>.m3u8          one video stream / a<itag>.m3u8 one audio stream
//   GET  /v1/videos/<id>/<itag>.mp4|.m4a       the stream's bytes, with Range support
//   GET  /v1/videos/<id>/progressive.mp4       360p video+audio in one file (fallback)
//   GET  /v1/videos/<id>/audio.m4a             the best AAC audio as one file
//   POST /v1/videos/<id>/prefetch              fetch the audio to the disk cache in the background
//   GET  /v1/queue.m3u8?ids=a,b,c              several videos' audio as one continuous stream
//   GET  /v1/queue.json?ids=a,b,c              where each track starts in that stream
//   GET  /v1/thumbs/<id>/<variant>.jpg         a thumbnail from i.ytimg.com
import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import { cleanSearchQuery, isVideoId, parseYouTubeVideoId, THUMBNAIL_VARIANTS, thumbnailUrl } from './ids.mjs'
import { masterPlaylist, mediaPlaylist, queuePlaylist, queueTimeline, streamFileName } from './hls.mjs'
import { Mp4IndexError } from './mp4.mjs'
import { searchResult } from './formats.mjs'
import { fetchAllowed, parseRange, readRange, UpstreamError } from './upstream.mjs'
import { YtDlpError } from './ytdlp.mjs'

const VIDEO_PATH = /^\/v1\/videos\/([A-Za-z0-9_-]{11})(?:\/(.+))?$/
const STREAM_FILE = /^(\d{1,4})\.(mp4|m4a)$/
const PLAYLIST_FILE = /^([va])(\d{1,4})\.m3u8$/
const THUMB_PATH = /^\/v1\/thumbs\/([A-Za-z0-9_-]{11})\/([a-z]+)\.jpg$/
const MAX_QUEUE = 20
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

export function createDiagnostics(max = 50, now = Date.now) {
  const recent = []
  const counts = {}
  return {
    record(operation, videoId, error) {
      const code = error?.code || 'error'
      counts[code] = (counts[code] || 0) + 1
      recent.unshift({ at: new Date(now()).toISOString(), operation, videoId: videoId || null, code, message: String(error?.message || error).slice(0, 300) })
      recent.length = Math.min(recent.length, max)
    },
    snapshot: () => ({ counts: { ...counts }, recent: recent.map((entry) => ({ ...entry })) }),
  }
}

function digest(value) { return createHash('sha256').update(String(value)).digest() }

export function bearerMatches(header, token) {
  if (!token) return true
  const match = /^Bearer (.+)$/.exec(String(header || ''))
  return Boolean(match) && timingSafeEqual(digest(match[1]), digest(token))
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}

function sendPlaylist(request, response, body) {
  response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
  response.end(request.method === 'HEAD' ? undefined : body)
}

function errorStatus(error) {
  if (error instanceof ApiError || error instanceof YtDlpError || error instanceof UpstreamError) return error.status
  if (error instanceof Mp4IndexError) return 422
  return 500
}

function errorCode(error) {
  if (error instanceof Mp4IndexError) return 'no-segment-index'
  return error?.code && typeof error.code === 'string' ? error.code : 'internal-error'
}

async function writeAll(response, chunks, signal) {
  for await (const chunk of chunks) {
    if (signal.aborted || response.destroyed) return
    if (!response.write(chunk)) await Promise.race([once(response, 'drain'), once(response, 'close')])
  }
}

export function createHandler({ config, ytdlp, resolver, cache = null, fetch = globalThis.fetch, diagnostics = createDiagnostics(), log = () => {}, version = null }) {
  let activeStreams = 0
  let activeFills = 0

  // Fills the audio cache for a video in the background; returns what happened.
  async function prefetchAudio(videoId) {
    if (!cache) return 'disabled'
    const entry = await resolver.get(videoId)
    const audio = entry.selection.audio[0]
    if (!audio) return 'no-audio'
    if (await cache.lookup(videoId, audio.itag)) return 'cached'
    if (cache.isFilling(videoId, audio.itag)) return 'filling'
    if (activeFills >= config.cache.maxConcurrentFills) return 'busy'
    const total = await resolver.size(videoId, audio.itag)
    if (total > config.cache.maxFileBytes) return 'too-large'
    activeFills += 1
    void cache.fill(videoId, audio.itag, total, () => readRange(audio, 0, total - 1, { refresh: resolver.refresher(videoId, audio.itag), fetch, chunkSize: audio.chunkSize || undefined }))
      .catch((error) => diagnostics.record('prefetch', videoId, error))
      .finally(() => { activeFills -= 1 })
    // Warm the index too, so the HLS playlist is ready.
    void resolver.index(videoId, audio.itag).catch(() => undefined)
    return 'started'
  }

  async function streamAlias(videoId, name) {
    const entry = await resolver.get(videoId)
    const format = name === 'progressive.mp4' ? entry.selection.progressive[0] : entry.selection.audio[0]
    if (!format) throw new ApiError(404, 'format-not-found', name === 'progressive.mp4' ? 'This video has no single-file MP4 format.' : 'This video has no AAC audio.')
    return format
  }

  async function serveStream(request, response, videoId, format) {
    if (activeStreams >= config.maxStreams) throw new ApiError(503, 'busy', 'Too many streams are playing. Try again in a moment.')
    activeStreams += 1
    const controller = new AbortController()
    const abort = () => controller.abort()
    response.on('close', abort)
    try {
      const cached = format.kind === 'audio' && cache ? await cache.lookup(videoId, format.itag) : null
      const total = cached?.size || await resolver.size(videoId, format.itag)
      const range = parseRange(request.headers.range, total)
      if (range === 'unsatisfiable') {
        response.writeHead(416, { 'content-range': `bytes */${total}`, 'cache-control': 'no-store' })
        return response.end()
      }
      const { start, end } = range || { start: 0, end: total - 1 }
      const headers = {
        'content-type': format.mimeType,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        // The bytes of one itag never change, but the stream must not sit in any shared cache.
        'cache-control': 'private, no-transform, max-age=3600',
        'x-tomtube-source': cached ? 'cache' : 'youtube',
      }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${total}`
      response.writeHead(range ? 206 : 200, headers)
      if (request.method === 'HEAD') return response.end()
      const chunks = cached
        ? createReadStream(cached.path, { start, end, highWaterMark: 256 * 1024 })
        : readRange(format, start, end, { refresh: resolver.refresher(videoId, format.itag), signal: controller.signal, fetch, chunkSize: format.chunkSize || undefined })
      await writeAll(response, chunks, controller.signal)
      if (!response.destroyed) response.end()
    } finally {
      activeStreams -= 1
      response.off('close', abort)
    }
  }

  async function videoRequest(request, response, videoId, file) {
    if (!file) {
      if (request.method !== 'GET') throw new ApiError(405, 'method-not-allowed', 'Use GET.')
      return sendJson(response, 200, (await resolver.get(videoId)).summary)
    }
    if (file === 'prefetch') {
      if (request.method !== 'POST') throw new ApiError(405, 'method-not-allowed', 'Use POST.')
      return sendJson(response, 202, { state: await prefetchAudio(videoId) })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'method-not-allowed', 'Use GET.')
    if (file === 'master.m3u8') {
      const { selection } = await resolver.get(videoId)
      if (!selection.video.length || !selection.audio.length) throw new ApiError(422, 'no-hls', 'This video has no H.264 streams for HLS; use progressive.mp4.')
      return sendPlaylist(request, response, masterPlaylist(selection.video, selection.audio[0]))
    }
    if (file === 'audio.m3u8') {
      const { selection } = await resolver.get(videoId)
      const audio = selection.audio[0]
      if (!audio) throw new ApiError(422, 'no-audio', 'This video has no AAC audio.')
      const index = await resolver.index(videoId, audio.itag)
      // Asking for audio means audio mode: keep a copy on disk so a locked phone doesn't depend on YouTube.
      void prefetchAudio(videoId).catch((error) => diagnostics.record('prefetch', videoId, error))
      return sendPlaylist(request, response, mediaPlaylist(index, streamFileName(audio)))
    }
    const playlist = PLAYLIST_FILE.exec(file)
    if (playlist) {
      const format = await resolver.format(videoId, playlist[2])
      if ((playlist[1] === 'v') !== (format.kind === 'video')) throw new ApiError(404, 'format-not-found', 'That playlist does not exist.')
      return sendPlaylist(request, response, mediaPlaylist(await resolver.index(videoId, format.itag), streamFileName(format)))
    }
    if (file === 'progressive.mp4' || file === 'audio.m4a') return serveStream(request, response, videoId, await streamAlias(videoId, file))
    const stream = STREAM_FILE.exec(file)
    if (stream) {
      const format = await resolver.format(videoId, stream[1])
      if ((stream[2] === 'm4a') !== (format.kind === 'audio')) throw new ApiError(404, 'format-not-found', 'That stream does not exist.')
      return serveStream(request, response, videoId, format)
    }
    throw new ApiError(404, 'not-found', 'Not found.')
  }

  function queueIds(url) {
    const ids = String(url.searchParams.get('ids') || '').split(',').map((value) => value.trim()).filter(Boolean)
    if (!ids.length || ids.length > MAX_QUEUE || !ids.every(isVideoId)) throw new ApiError(400, 'invalid-queue', `Give 1 to ${MAX_QUEUE} video ids.`)
    return ids
  }

  async function queueTracks(ids) {
    const tracks = []
    const skipped = []
    // Three at a time: each may need a yt-dlp run.
    for (let offset = 0; offset < ids.length; offset += 3) {
      const batch = await Promise.all(ids.slice(offset, offset + 3).map(async (videoId) => {
        try {
          const { selection } = await resolver.get(videoId)
          const format = selection.audio[0]
          if (!format) throw new ApiError(422, 'no-audio', 'No AAC audio.')
          return { videoId, format, index: await resolver.index(videoId, format.itag) }
        } catch (error) {
          diagnostics.record('queue', videoId, error)
          skipped.push({ id: videoId, error: errorCode(error) })
          return null
        }
      }))
      tracks.push(...batch.filter(Boolean))
    }
    if (!tracks.length) throw new ApiError(422, 'queue-unplayable', 'None of the queued videos could be played.')
    return { tracks, skipped }
  }

  async function thumbnail(request, response, videoId, variant) {
    if (!THUMBNAIL_VARIANTS.includes(variant)) throw new ApiError(404, 'not-found', 'Unknown thumbnail.')
    let upstream = await fetchAllowed(thumbnailUrl(videoId, variant), { kind: 'image', fetch, timeoutMs: 10_000 })
    // Not every video has the larger sizes.
    if (upstream.status === 404 && variant !== 'hqdefault') {
      await upstream.body?.cancel().catch(() => undefined)
      upstream = await fetchAllowed(thumbnailUrl(videoId, 'hqdefault'), { kind: 'image', fetch, timeoutMs: 10_000 })
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined)
      throw new ApiError(upstream.status === 404 ? 404 : 502, 'thumbnail-unavailable', 'The thumbnail could not be loaded.')
    }
    const body = Buffer.from(await upstream.arrayBuffer())
    if (body.length > MAX_THUMBNAIL_BYTES) throw new ApiError(502, 'thumbnail-unavailable', 'The thumbnail is too large.')
    response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length), 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  async function route(request, response, url) {
    const { pathname } = url
    if (pathname === '/v1/status') {
      return sendJson(response, 200, {
        version,
        ytdlp: { version: await ytdlp.version(), running: ytdlp.limiter.active, queued: ytdlp.limiter.queued },
        streams: { active: activeStreams, max: config.maxStreams },
        resolver: resolver.stats(),
        cache: cache ? await cache.stats() : null,
        failures: diagnostics.snapshot(),
      })
    }
    if (pathname === '/v1/search') {
      const query = cleanSearchQuery(url.searchParams.get('q'))
      if (!query) throw new ApiError(400, 'invalid-query', 'Enter something to search for.')
      // A pasted link in the search box opens that video.
      const linked = parseYouTubeVideoId(query)
      if (linked && /youtu\.be|youtube\./i.test(query)) {
        const { summary: { id, title, channel, channelId, duration, viewCount, isLive } } = await resolver.get(linked)
        return sendJson(response, 200, { query, results: [{ id, title, channel, channelId, duration, viewCount, isLive }] })
      }
      const limit = Math.min(config.searchLimit, Math.max(1, Number(url.searchParams.get('limit')) || config.searchLimit))
      const result = await ytdlp.search(query, limit)
      return sendJson(response, 200, { query, results: (Array.isArray(result?.entries) ? result.entries : []).map(searchResult).filter(Boolean) })
    }
    if (pathname === '/v1/resolve') {
      const videoId = parseYouTubeVideoId(url.searchParams.get('url'))
      if (!videoId) throw new ApiError(400, 'invalid-url', 'That is not a YouTube video link.')
      return sendJson(response, 200, (await resolver.get(videoId)).summary)
    }
    if (pathname === '/v1/queue.m3u8' || pathname === '/v1/queue.json') {
      const { tracks, skipped } = await queueTracks(queueIds(url))
      if (pathname.endsWith('.json')) return sendJson(response, 200, { tracks: queueTimeline(tracks), skipped })
      return sendPlaylist(request, response, queuePlaylist(tracks))
    }
    const thumb = THUMB_PATH.exec(pathname)
    if (thumb) return thumbnail(request, response, thumb[1], thumb[2])
    const video = VIDEO_PATH.exec(pathname)
    if (video) return videoRequest(request, response, video[1], video[2])
    throw new ApiError(404, 'not-found', 'Not found.')
  }

  return async function handle(request, response) {
    let url
    try { url = new URL(request.url || '/', 'http://tomtube') } catch { return sendJson(response, 400, { error: 'bad-request' }) }
    if (url.pathname === '/health') return sendJson(response, 200, { ok: true, version })
    if (!url.pathname.startsWith('/v1/')) return sendJson(response, 404, { error: 'not-found' })
    if (!bearerMatches(request.headers.authorization, config.token)) return sendJson(response, 401, { error: 'unauthorized' })
    const videoId = VIDEO_PATH.exec(url.pathname)?.[1] || THUMB_PATH.exec(url.pathname)?.[1] || null
    try {
      await route(request, response, url)
    } catch (error) {
      const status = errorStatus(error)
      const code = errorCode(error)
      if (status >= 500 || error instanceof YtDlpError || error instanceof Mp4IndexError) diagnostics.record(url.pathname.split('/')[2] || 'request', videoId, error)
      if (status === 500) log(`TomTube request failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
      if (response.headersSent) { response.destroy(); return }
      sendJson(response, status, { error: code, message: status === 500 ? 'Something went wrong in TomTube.' : error.message })
    }
  }
}
