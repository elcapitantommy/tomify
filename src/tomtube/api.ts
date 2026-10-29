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

// A suggestion from the server's training log (tomtube-service/training.mjs), with why it is shown.
export interface RecommendedVideo extends TomTubeVideo { reason?: string; publishedAt?: string }
export interface RecommendationShelf { id: 'youtube' | 'channels' | 'discover' | 'topics'; title: string; videos: RecommendedVideo[] }
export interface Recommendations { generatedAt: string; source: 'youtube' | 'training' | 'none'; cookies: CookieState; topics: string[]; shelves: RecommendationShelf[] }

export type CookieState = 'missing' | 'checking' | 'valid' | 'expired' | 'error'
export interface TrainingStatus {
  cookies: { state: CookieState; updatedAt: string | null; expiresAt: string | null; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: { code: string; message: string; at: string } | null; nextSyncAt: string | null; encrypted: boolean }
  learned: { watches: number; finished: number; skipped: number; notInterested: number; youtubeHistory: number; subscriptions: number; channels: number; recommendedChannels: number; recommendedSyncedAt: string | null }
  syncIntervalHours: number
  // Whether this account may add YouTube account cookies (only the owner). Each account has its own profile.
  youtubeAccount?: boolean
  lastImport: { at: string; problems: string[]; feeds: Array<{ feed: string; ok: boolean; videos: number; channels: number }> } | null
}

// One sync's import report (tomtube-service/training.mjs inspectFeed), for checking real YouTube data.
export interface ImportFeedReport {
  feed: string; ok: boolean; ms: number; code?: string; signedOut?: boolean; message?: string
  shape?: { type: string | null; extractor: string | null; hasEntries: boolean }
  entries?: number; videos?: number; dropped?: number; droppedKinds?: Array<[string, number]>
  missing?: { channelId: number; channel: number; title: number; duration: number }
  backfilled?: number; channels?: number; fields?: string[]
  sample?: Array<{ id: string; title: string; channel: string; channelId: string | null }>
  warnings?: string[]
}
export interface ImportReport { at: string; feeds: ImportFeedReport[]; problems: string[] }

// What the app reports when a video stops being watched (or reaches 30 seconds, or ends).
export interface WatchReport { id: string; title: string; channel: string; channelId: string | null; duration: number | null; seconds: number; ended: boolean; skipped?: boolean }

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
  recommendations: (session: AuthSession, refresh = false, signal?: AbortSignal) => request<Recommendations>(session, refresh ? 'recommendations?refresh=1' : 'recommendations', { signal }),
  watched: (session: AuthSession, report: WatchReport) => request<{ ok: boolean }>(session, 'watched', { method: 'POST', body: JSON.stringify(report), headers: { 'content-type': 'application/json' }, keepalive: true }),
  // "Not interested" on a suggestion: a strong negative for the model.
  notInterested: (session: AuthSession, video: TomTubeVideo) => request<{ ok: boolean }>(session, 'feedback', { method: 'POST', body: JSON.stringify({ id: video.id, kind: 'not-interested', channelId: video.channelId ?? null, channel: video.channel, title: video.title }), headers: { 'content-type': 'application/json' } }),
  training: (session: AuthSession) => request<TrainingStatus>(session, 'training'),
  clearTraining: (session: AuthSession) => request<TrainingStatus>(session, 'training', { method: 'DELETE' }),
  // The cookie file goes to the server and is never read back.
  uploadCookies: (session: AuthSession, cookies: string) => request<TrainingStatus>(session, 'training/cookies', { method: 'PUT', body: cookies, headers: { 'content-type': 'text/plain' } }),
  removeCookies: (session: AuthSession) => request<TrainingStatus>(session, 'training/cookies', { method: 'DELETE' }),
  imports: (session: AuthSession) => request<{ reports: ImportReport[] }>(session, 'training/imports'),
  syncTraining: (session: AuthSession) => request<TrainingStatus>(session, 'training/sync', { method: 'POST' }),
}

// The query that signs a media URL right now; null until a media token is available.
export function mediaQuery(session: AuthSession, now = Date.now()) {
  const token = mediaToken(session.username, now)
  return token ? new URLSearchParams({ mt: token }).toString() : null
}

export type MediaFile = 'master.m3u8' | 'video.m3u8' | 'audio.m3u8' | 'progressive.mp4' | 'audio.m4a'

// `height` (master.m3u8 / video.m3u8 only): one fixed quality up to that height instead of adaptive.
export function mediaUrl(session: AuthSession, id: string, file: MediaFile, height?: number) {
  const query = mediaQuery(session)
  if (!query) return null
  const fixed = height && (file === 'master.m3u8' || file === 'video.m3u8') ? `height=${height}&` : ''
  return `/api/tomtube/videos/${encodeURIComponent(id)}/${file}?${fixed}${query}`
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
