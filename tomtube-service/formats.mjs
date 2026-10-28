// Choosing what an iPhone can play from yt-dlp's format list, without transcoding.
//
// iOS plays H.264 (avc1) video and AAC (mp4a) audio in MP4 natively. YouTube offers:
//   - "adaptive" formats: video-only avc1 MP4s (144p to 1080p) and audio-only AAC M4As, each a
//     fragmented MP4 with a segment index (sidx). TomTube describes them to the phone as HLS with
//     byte ranges (hls.mjs), so Safari plays and seeks them itself, at up to 1080p, with no ffmpeg.
//   - one "progressive" format (itag 18): 360p H.264 + AAC in one ordinary MP4. It is the fallback
//     when HLS fails, and plays with plain byte ranges.
// Only formats yt-dlp can fetch over plain HTTPS with a direct URL are used (not SABR, not DASH or HLS
// manifests), and upstream URLs never leave the service.

export const DEFAULT_MAX_HEIGHT = 1080

function isHttps(format) {
  return typeof format?.url === 'string' && format.url.startsWith('https://') && (!format.protocol || format.protocol === 'https')
}

function codec(value) {
  return typeof value === 'string' && value !== 'none' ? value : null
}

export function isVideoOnlyAvc(format, maxHeight = DEFAULT_MAX_HEIGHT) {
  const video = codec(format?.vcodec)
  return isHttps(format) && format.ext === 'mp4' && Boolean(video?.startsWith('avc1')) && !codec(format.acodec)
    && Number(format.height) > 0 && Number(format.height) <= maxHeight
}

export function isAudioOnlyAac(format) {
  const audio = codec(format?.acodec)
  return isHttps(format) && ['m4a', 'mp4'].includes(format.ext) && Boolean(audio?.startsWith('mp4a')) && !codec(format.vcodec)
}

export function isProgressiveMp4(format) {
  const video = codec(format?.vcodec)
  const audio = codec(format?.acodec)
  return isHttps(format) && format.ext === 'mp4' && Boolean(video?.startsWith('avc1')) && Boolean(audio?.startsWith('mp4a'))
}

// Dubbed and "stable volume" (drc) copies are left out unless they are all there is.
function audioRank(format) {
  const id = String(format.format_id || '')
  const drc = /-drc$/.test(id) ? -1000 : 0
  const language = Number(format.language_preference ?? 0)
  return drc + language * 100 + Number(format.abr || format.tbr || 0) / 1000
}

function bitrate(format) {
  const kbps = Number(format.tbr || format.vbr || format.abr || 0)
  if (kbps > 0) return Math.round(kbps * 1000)
  const size = Number(format.filesize || format.filesize_approx || 0)
  const duration = Number(format.duration || 0)
  return size > 0 && duration > 0 ? Math.round((size * 8) / duration) : 0
}

export function itagOf(format) {
  const match = /^(\d+)/.exec(String(format?.format_id || ''))
  return match ? match[1] : null
}

// The googlevideo URL says when it stops working (seconds since 1970).
export function urlExpiry(url) {
  try {
    const expire = Number(new URL(url).searchParams.get('expire'))
    return Number.isFinite(expire) && expire > 0 ? expire * 1000 : null
  } catch { return null }
}

function contentLength(format) {
  const size = Number(format.filesize)
  if (Number.isFinite(size) && size > 0) return size
  try {
    const clen = Number(new URL(format.url).searchParams.get('clen'))
    return Number.isFinite(clen) && clen > 0 ? clen : null
  } catch { return null }
}

function playable(format, kind) {
  return {
    itag: itagOf(format),
    formatId: String(format.format_id),
    kind,
    container: kind === 'audio' ? 'm4a' : 'mp4',
    mimeType: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    vcodec: codec(format.vcodec),
    acodec: codec(format.acodec),
    width: Number(format.width) || null,
    height: Number(format.height) || null,
    fps: Number(format.fps) || null,
    bitrate: bitrate(format),
    size: contentLength(format),
    language: typeof format.language === 'string' ? format.language : null,
    url: format.url,
    headers: format.http_headers && typeof format.http_headers === 'object' ? { ...format.http_headers } : {},
    chunkSize: Number(format.downloader_options?.http_chunk_size) || null,
    expiresAt: urlExpiry(format.url),
  }
}

// One format per itag (the first, best-ranked one), so `/<itag>.mp4` always names one stream.
function uniqueByItag(list) {
  const seen = new Set()
  return list.filter((format) => { if (!format.itag || seen.has(format.itag)) return false; seen.add(format.itag); return true })
}

export function selectFormats(formats, { maxHeight = DEFAULT_MAX_HEIGHT } = {}) {
  const list = Array.isArray(formats) ? formats : []
  const audio = uniqueByItag(list.filter(isAudioOnlyAac).sort((a, b) => audioRank(b) - audioRank(a)).map((format) => playable(format, 'audio')))
  // Highest frame rate first at each height, then one variant per height.
  const byHeight = new Map()
  for (const format of list.filter((candidate) => isVideoOnlyAvc(candidate, maxHeight)).sort((a, b) => (Number(b.fps) || 0) - (Number(a.fps) || 0) || bitrate(b) - bitrate(a))) {
    if (!byHeight.has(Number(format.height))) byHeight.set(Number(format.height), playable(format, 'video'))
  }
  const video = uniqueByItag([...byHeight.values()].sort((a, b) => a.height - b.height))
  const progressive = uniqueByItag(list.filter(isProgressiveMp4).sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0)).map((format) => playable(format, 'progressive')))
  return { audio, video, progressive }
}

// What the phone is told about the formats: never the upstream URL or request headers.
export function publicFormat(format) {
  if (!format) return null
  const { url: _url, headers: _headers, chunkSize: _chunkSize, expiresAt: _expiresAt, ...rest } = format
  return rest
}

export function earliestExpiry(selection) {
  const times = [...selection.audio, ...selection.video, ...selection.progressive].map((format) => format.expiresAt).filter(Boolean)
  return times.length ? Math.min(...times) : null
}

export function findFormat(selection, itag) {
  const id = String(itag)
  return selection.video.find((format) => format.itag === id)
    || selection.audio.find((format) => format.itag === id)
    || selection.progressive.find((format) => format.itag === id)
    || null
}

// The video's details as the phone sees them.
export function videoSummary(info, selection) {
  return {
    id: String(info.id),
    title: String(info.title || info.fulltitle || 'Untitled'),
    channel: String(info.channel || info.uploader || ''),
    channelId: typeof info.channel_id === 'string' ? info.channel_id : null,
    duration: Number(info.duration) || null,
    viewCount: Number(info.view_count) || null,
    uploadDate: typeof info.upload_date === 'string' ? info.upload_date : null,
    isLive: info.is_live === true || info.live_status === 'is_live',
    formats: {
      video: selection.video.map(publicFormat),
      audio: selection.audio.map(publicFormat),
      progressive: selection.progressive.map(publicFormat),
    },
    playback: {
      hls: selection.video.length > 0 && selection.audio.length > 0,
      progressive: selection.progressive.length > 0,
      audio: selection.audio.length > 0,
    },
  }
}

// A search hit from `--flat-playlist`.
export function searchResult(entry) {
  if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(entry.id)) return null
  if (entry.ie_key && entry.ie_key !== 'Youtube') return null
  const live = entry.live_status === 'is_live' || entry.is_live === true
  return {
    id: entry.id,
    title: String(entry.title || 'Untitled'),
    channel: String(entry.channel || entry.uploader || ''),
    channelId: typeof entry.channel_id === 'string' ? entry.channel_id : null,
    duration: Number(entry.duration) || null,
    viewCount: Number(entry.view_count) || null,
    isLive: live,
  }
}
