// TomTube's calls to the Worker (worker/routes/tomtube.ts), which passes them on to the TomTube
// service on the media server. JSON calls carry the Tomify sign-in as x-tomify-* headers. Media URLs
// (playlists, streams, thumbnails) are used by <video>, <audio> and <img>, which can't send headers,
// so they carry only a short-lived media token (`mt`, see mediaToken.ts), never the Navidrome login.
// Until a token is available the URL builders return null.
import type { AuthSession } from '../lib/navidrome'
import { mediaToken } from './mediaToken'

export interface TomTubeVideo {
  id: string
  title: string
  channel: string
  channelId?: string | null
  duration: number | null
  viewCount?: number | null
  isLive?: boolean
}

export interface TomTubeFormat { itag: string; kind: 'video' | 'audio' | 'progressive'; width: number | null; height: number | null; fps: number | null; bitrate: number; vcodec: string | null; acodec: string | null }

export interface TomTubeDetails extends TomTubeVideo {
  uploadDate: string | null
  formats: { video: TomTubeFormat[]; audio: TomTubeFormat[]; progressive: TomTubeFormat[] }
  playback: { hls: boolean; progressive: boolean; audio: boolean }
}

export interface QueueTimeline { tracks: Array<{ id: string; offset: number; duration: number }>; skipped: Array<{ id: string; error: string }> }

export class TomTubeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = 'TomTubeError' }
}

const MESSAGES: Record<string, string> = {
  'not-configured': 'TomTube is not set up on the Tomify server yet.',
  'tomtube-unavailable': 'The TomTube service on the media server is not answering.',
  unauthorized: 'Your Tomify sign-in has expired. Sign in again.',
  forbidden: 'TomTube is not enabled for this account.',
  'media-tokens-not-configured': 'TomTube needs secure media links, which are not set up on the Tomify server yet.',
}

function headers(session: AuthSession): HeadersInit {
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
}

async function request<T>(session: AuthSession, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/tomtube/${path}`, { cache: 'no-store', credentials: 'omit', ...init, headers: { ...headers(session), ...init.headers } }) }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new TomTubeError('Tomify could not be reached. Check your connection.', 0, 'network')
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new TomTubeError(body.message || MESSAGES[body.error || ''] || `TomTube failed (HTTP ${response.status}).`, response.status, body.error || 'error')
  return body
}

export const tomtubeApi = {
  search: (session: AuthSession, query: string, signal?: AbortSignal) => request<{ query: string; results: TomTubeVideo[] }>(session, `search?${new URLSearchParams({ q: query })}`, { signal }),
  resolve: (session: AuthSession, url: string, signal?: AbortSignal) => request<TomTubeDetails>(session, `resolve?${new URLSearchParams({ url })}`, { signal }),
  video: (session: AuthSession, id: string, signal?: AbortSignal) => request<TomTubeDetails>(session, `videos/${encodeURIComponent(id)}`, { signal }),
  prefetch: (session: AuthSession, id: string) => request<{ state: string }>(session, `videos/${encodeURIComponent(id)}/prefetch`, { method: 'POST' }),
  queueTimeline: (session: AuthSession, ids: string[]) => request<QueueTimeline>(session, `queue.json?${new URLSearchParams({ ids: ids.join(',') })}`),
  status: (session: AuthSession) => request<Record<string, unknown>>(session, 'status'),
}

// The query that signs a media URL right now; null until a media token is available.
export function mediaQuery(session: AuthSession, now = Date.now()) {
  const token = mediaToken(session.username, now)
  return token ? new URLSearchParams({ mt: token }).toString() : null
}

export type MediaFile = 'master.m3u8' | 'video.m3u8' | 'audio.m3u8' | 'progressive.mp4' | 'audio.m4a'

export function mediaUrl(session: AuthSession, id: string, file: MediaFile) {
  const query = mediaQuery(session)
  return query ? `/api/tomtube/videos/${encodeURIComponent(id)}/${file}?${query}` : null
}

export function queueStreamUrl(session: AuthSession, ids: string[]) {
  const query = mediaQuery(session)
  return query ? `/api/tomtube/queue.m3u8?ids=${ids.map(encodeURIComponent).join(',')}&${query}` : null
}

export function thumbnailUrl(session: AuthSession, id: string, variant: 'mqdefault' | 'hqdefault' | 'maxresdefault' = 'mqdefault', absolute = false) {
  const query = mediaQuery(session)
  if (!query) return null
  const path = `/api/tomtube/thumbs/${encodeURIComponent(id)}/${variant}.jpg?${query}`
  return absolute ? new URL(path, window.location.origin).href : path
}

// A pasted YouTube link (any common shape) → its video id; null for plain search text.
export function youtubeLinkId(text: string): string | null {
  const value = text.trim()
  if (!/youtu\.be|youtube\.|youtube-nocookie\./i.test(value)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '')
    const parts = url.pathname.split('/').filter(Boolean)
    const id = host === 'youtu.be' ? parts[0] : parts[0] === 'watch' ? url.searchParams.get('v') : ['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : null
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
  } catch { return null }
}

export function formatDuration(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return ''
  const whole = Math.floor(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function formatViews(count: number | null | undefined) {
  if (!count) return ''
  if (count >= 1e9) return `${(count / 1e9).toFixed(1).replace(/\.0$/, '')}B views`
  if (count >= 1e6) return `${(count / 1e6).toFixed(1).replace(/\.0$/, '')}M views`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1).replace(/\.0$/, '')}K views`
  return `${count} views`
}
