// Fetching media bytes from YouTube's video servers, and only from them.
//
// The service fetches three kinds of upstream URL: googlevideo.com media URLs that yt-dlp resolved,
// i.ytimg.com thumbnails it builds itself from a video id, and a channel's public RSS feed
// (www.youtube.com/feeds/videos.xml?channel_id=UC…) for suggestions. Anything else, including a redirect to
// anywhere else, is refused. Redirects are followed by hand so each hop is checked.

export class UpstreamError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
  }
}

const MEDIA_HOST = /^(?:[a-z0-9-]+\.)*googlevideo\.com$/
const IMAGE_HOSTS = new Set(['i.ytimg.com'])

export function isAllowedUpstream(value, kind = 'media') {
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const host = url.hostname.toLowerCase()
  // A channel's public uploads feed, for suggestions (training.mjs).
  if (kind === 'feed') return host === 'www.youtube.com' && url.pathname === '/feeds/videos.xml' && /^channel_id=UC[A-Za-z0-9_-]{22}$/.test(url.search.slice(1))
  return kind === 'image' ? IMAGE_HOSTS.has(host) : MEDIA_HOST.test(host)
}

// Request headers yt-dlp says the format needs, minus anything that could carry a credential or
// that the service sets itself.
export function upstreamHeaders(formatHeaders = {}) {
  const headers = {}
  for (const [name, value] of Object.entries(formatHeaders || {})) {
    const key = name.toLowerCase()
    if (['cookie', 'authorization', 'range', 'host', 'content-length', 'connection', 'accept-encoding'].includes(key)) continue
    if (typeof value === 'string' && value.length < 2000) headers[key] = value
  }
  return headers
}

export async function fetchAllowed(url, { kind = 'media', headers = {}, signal, fetch: fetcher = globalThis.fetch, maxRedirects = 3, timeoutMs = 20_000 } = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isAllowedUpstream(current, kind)) throw new UpstreamError('upstream-refused', 'Refused to fetch a URL outside YouTube\'s media servers.', 502)
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetcher(current, { headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => undefined)
      current = new URL(response.headers.get('location'), current).href
      continue
    }
    return response
  }
  throw new UpstreamError('upstream-redirects', 'Too many redirects from YouTube.', 502)
}

// `Range: bytes=…` → { start, end } within a file of `size` bytes; null for no or an unusable header,
// 'unsatisfiable' for a range outside the file. Only single ranges are supported (all a player sends).
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match || (!match[1] && !match[2])) return null
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!suffix) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

// The total size of an upstream file, from a one-byte request, when yt-dlp did not report it.
export async function probeSize(format, options = {}) {
  const response = await fetchAllowed(format.url, { ...options, headers: { ...upstreamHeaders(format.headers), range: 'bytes=0-0' } })
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 403 || response.status === 410) throw new UpstreamError('upstream-expired', 'The YouTube stream address has expired.', 502)
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') || '')?.[1])
  if (!Number.isFinite(total) || total <= 0) throw new UpstreamError('upstream-size', 'YouTube did not say how big the stream is.', 502)
  return total
}

// Reads bytes [start, end] of a format, in requests of at most `chunkSize` bytes (YouTube slows down
// larger ones), yielding Buffers. A dropped connection resumes where it stopped; an expired address
// calls `refresh()` for a new format and carries on. `signal` stops everything (the phone went away).
export async function* readRange(initialFormat, start, end, { refresh, signal, fetch: fetcher, chunkSize = 10 * 1024 * 1024, retries = 3, timeoutMs } = {}) {
  let format = initialFormat
  let position = start
  let failures = 0
  let refreshed = false
  while (position <= end) {
    if (signal?.aborted) return
    const last = Math.min(end, position + chunkSize - 1)
    let response
    try {
      response = await fetchAllowed(format.url, { headers: { ...upstreamHeaders(format.headers), range: `bytes=${position}-${last}` }, signal, fetch: fetcher, timeoutMs })
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof UpstreamError) throw error
      if (++failures > retries) throw new UpstreamError('upstream-network', 'Lost the connection to YouTube.', 502)
      continue
    }
    if (response.status === 403 || response.status === 410 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      if (!refresh || refreshed) throw new UpstreamError('upstream-expired', 'The YouTube stream address has expired and could not be renewed.', 502)
      refreshed = true
      format = await refresh()
      continue
    }
    if (response.status !== 206 && !(response.status === 200 && position === 0)) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status >= 500 && ++failures <= retries) continue
      throw new UpstreamError('upstream-status', `YouTube answered HTTP ${response.status}.`, 502)
    }
    const wanted = last - position + 1
    let received = 0
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        const take = Math.min(buffer.length, wanted - received)
        if (take > 0) yield take === buffer.length ? buffer : buffer.subarray(0, take)
        received += take
        if (received >= wanted) break
      }
    } catch (error) {
      if (signal?.aborted) return
      if (++failures > retries) throw new UpstreamError('upstream-network', 'Lost the connection to YouTube.', 502)
    } finally {
      if (received >= wanted) await response.body?.cancel().catch(() => undefined)
    }
    position += received
    if (received > 0) { failures = 0; refreshed = false }
    else if (++failures > retries) throw new UpstreamError('upstream-network', 'YouTube sent no data.', 502)
  }
}
