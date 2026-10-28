// What a client may ask TomTube for. Clients never send a URL that the service fetches: a pasted
// YouTube link is reduced to its 11-character video id here, and every upstream URL is built by the
// service itself or comes from yt-dlp. That is the main defence against using TomTube as an open relay.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'])

export function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID.test(value)
}

// A YouTube link (watch, youtu.be, shorts, live, embed, music) or a bare id → the video id, or null.
export function parseYouTubeVideoId(input) {
  const text = String(input ?? '').trim()
  if (!text || text.length > 2048) return null
  if (isVideoId(text)) return text
  let url
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  if (!YOUTUBE_HOSTS.has(host)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  let candidate = null
  if (host === 'youtu.be') candidate = parts[0]
  else if (parts[0] === 'watch' || parts.length === 0) candidate = url.searchParams.get('v')
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0])) candidate = parts[1]
  return isVideoId(candidate) ? candidate : null
}

export function watchUrl(videoId) {
  if (!isVideoId(videoId)) throw new TypeError('Not a YouTube video id.')
  return `https://www.youtube.com/watch?v=${videoId}`
}

// Search text is passed to yt-dlp as one argument behind a fixed `ytsearchN:` prefix, never through a shell.
export function cleanSearchQuery(value, maxLength = 200) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.slice(0, maxLength)
}

// Thumbnails are fetched only from YouTube's image host, by video id and one of these fixed names.
export const THUMBNAIL_VARIANTS = Object.freeze(['default', 'mqdefault', 'hqdefault', 'sddefault', 'maxresdefault'])

export function thumbnailUrl(videoId, variant) {
  if (!isVideoId(videoId) || !THUMBNAIL_VARIANTS.includes(variant)) return null
  return `https://i.ytimg.com/vi/${videoId}/${variant}.jpg`
}
