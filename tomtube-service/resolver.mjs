// Turns a video id into playable formats, and remembers the answer until YouTube's addresses expire.
//
// yt-dlp takes a few seconds per video, so each result is kept in memory (bounded) until shortly
// before its googlevideo URLs expire, and concurrent requests for the same video share one yt-dlp run.
// The fragment index of each stream (mp4.mjs) never changes, so it is kept longer, separately.
import { createReadStream } from 'node:fs'
import { earliestExpiry, findFormat, selectFormats, videoSummary } from './formats.mjs'
import { groupSegments, Mp4IndexError, readIndex } from './mp4.mjs'
import { probeSize, readRange } from './upstream.mjs'
import { YtDlpError } from './ytdlp.mjs'

const INDEX_FIRST_BYTES = 64 * 1024
const INDEX_MAX_BYTES = 2 * 1024 * 1024

function lru(max) {
  const map = new Map()
  return {
    get(key) { const value = map.get(key); if (value !== undefined) { map.delete(key); map.set(key, value) } return value },
    set(key, value) { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value) },
    delete(key) { map.delete(key) },
    get size() { return map.size },
  }
}

export function createResolver({ ytdlp, maxHeight, maxEntries = 200, expiryMarginMs = 15 * 60_000, fallbackTtlMs = 2 * 3600_000, segmentSeconds = 4, fetch, now = Date.now, audioCache = null }) {
  const videos = lru(maxEntries)
  const indexes = lru(maxEntries * 4)
  const sizes = lru(maxEntries * 4)
  const pending = new Map()

  async function load(videoId) {
    const info = await ytdlp.extract(videoId)
    if (!info || info.id !== videoId) throw new YtDlpError('extraction-failed', 'yt-dlp returned a different video.', 502)
    if (info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new YtDlpError('live-not-supported', 'Live streams are not supported by TomTube yet.', 422)
    const selection = selectFormats(info.formats, { maxHeight })
    const summary = videoSummary(info, selection)
    if (!summary.playback.hls && !summary.playback.progressive && !summary.playback.audio) throw new YtDlpError('no-compatible-format', 'YouTube offered no H.264 or AAC formats an iPhone can play for this video.', 422)
    const expiry = earliestExpiry(selection)
    const expiresAt = Math.min(expiry ? expiry - expiryMarginMs : Infinity, now() + fallbackTtlMs)
    return { summary, selection, fetchedAt: now(), expiresAt }
  }

  async function get(videoId, { fresh = false } = {}) {
    const cached = fresh ? undefined : videos.get(videoId)
    if (cached && cached.expiresAt > now()) return cached
    if (pending.has(videoId)) return pending.get(videoId)
    const task = load(videoId).then((entry) => { videos.set(videoId, entry); return entry }).finally(() => pending.delete(videoId))
    pending.set(videoId, task)
    return task
  }

  async function format(videoId, itag, { fresh = false } = {}) {
    const entry = await get(videoId, { fresh })
    const found = findFormat(entry.selection, itag)
    if (!found) throw new YtDlpError('format-not-found', 'That format is not available for this video.', 404)
    return found
  }

  // For upstream reads: a new address after the old one expired.
  function refresher(videoId, itag) {
    return async () => { videos.delete(videoId); return format(videoId, itag, { fresh: true }) }
  }

  async function size(videoId, itag) {
    const key = `${videoId}.${itag}`
    const known = sizes.get(key)
    if (known) return known
    const found = await format(videoId, itag)
    const total = found.size || await probeSize(found, { fetch })
    sizes.set(key, total)
    return total
  }

  async function readStart(videoId, itag, length) {
    const cached = audioCache ? await audioCache.lookup(videoId, itag) : null
    if (cached) {
      const chunks = []
      for await (const chunk of createReadStream(cached.path, { start: 0, end: Math.min(cached.size, length) - 1 })) chunks.push(chunk)
      return Buffer.concat(chunks)
    }
    const found = await format(videoId, itag)
    const total = await size(videoId, itag)
    const chunks = []
    for await (const chunk of readRange(found, 0, Math.min(total, length) - 1, { refresh: refresher(videoId, itag), fetch })) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  // The fragment index of one stream, as segments of at least `segmentSeconds`.
  async function index(videoId, itag) {
    const key = `${videoId}.${itag}`
    const known = indexes.get(key)
    if (known) return known
    if (pending.has(`index:${key}`)) return pending.get(`index:${key}`)
    const task = (async () => {
      const total = await size(videoId, itag)
      let length = INDEX_FIRST_BYTES
      for (;;) {
        const buffer = await readStart(videoId, itag, length)
        const result = readIndex(buffer, total)
        if (!result.needed) {
          const value = { init: result.init, segments: groupSegments(result.segments, segmentSeconds), duration: result.duration, size: total }
          indexes.set(key, value)
          return value
        }
        if (buffer.length >= total || result.needed > INDEX_MAX_BYTES) throw new Mp4IndexError('Could not find the stream\'s segment index.')
        length = Math.min(total, Math.max(result.needed, length * 2))
      }
    })().finally(() => pending.delete(`index:${key}`))
    pending.set(`index:${key}`, task)
    return task
  }

  return { get, format, refresher, size, index, invalidate: (videoId) => videos.delete(videoId), stats: () => ({ videos: videos.size, indexes: indexes.size, pending: pending.size }) }
}
