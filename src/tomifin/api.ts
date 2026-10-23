import { useAuth } from '../stores/auth'

export type TomifinDestination = 'family' | 'private'
export type TomifinKind = 'video' | 'movies' | 'tv'
export type TomifinStatus = 'queued' | 'downloading' | 'stalled' | 'paused' | 'completed' | 'failed'

export interface TomifinQuality { resolution: string | null; hdr: string | null; codec: string | null; source: string | null }
export interface TomifinResult {
  id: string; title: string; source: string; size: number | null; seeders: number; leechers: number | null
  type: 'torrent'; linkType: 'magnet' | 'torrent-file'; detailsUrl: string | null; quality: TomifinQuality
}
export interface TomifinJob {
  id: string; name: string; destination: TomifinDestination; destinationLabel: string; status: TomifinStatus; message: string | null
  progress: number; downloadSpeed: number | null; uploadSpeed: number | null; downloaded: number | null; size: number | null; eta: number | null
  seeds: number | null; peers: number | null; source: string | null; createdAt: string; canPause: boolean; canResume: boolean; keepsFilesOnCancel: boolean
}
export interface TomifinServiceStatus { available: boolean; problem: string | null; destinations: Array<{ id: TomifinDestination; label: string; available: boolean }> }

export const DESTINATIONS: Record<TomifinDestination, { label: string; path: string }> = {
  family: { label: 'Family', path: '/media/family' },
  private: { label: 'Private', path: '/media/private' },
}

export class TomifinRequestError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) { super(message); this.name = 'TomifinRequestError'; this.status = status; this.code = code }
}

// The same Navidrome sign-in Tomify uses: the Worker checks it, and the administrator role, on every request.
function headers(json: boolean): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new TomifinRequestError('Sign in to use Tomifin Downloader.', 401, 'unauthorized')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, ...(json ? { 'content-type': 'application/json' } : {}) }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { ...init, headers: { ...headers(Boolean(init.body)), ...init.headers } }) }
  catch (error) {
    if (error instanceof TomifinRequestError || (error instanceof DOMException && error.name === 'AbortError')) throw error
    throw new TomifinRequestError('Tomify could not be reached. Check your connection and try again.', 0, 'network')
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new TomifinRequestError(body.message || body.error || `Request failed (HTTP ${response.status}).`, response.status, body.error || 'error')
  return body
}

export const tomifinApi = {
  status: (signal?: AbortSignal) => request<TomifinServiceStatus>('/api/tomifin/status', { signal }),
  search: (query: string, kind: TomifinKind, signal?: AbortSignal) => request<{ query: string; kind: TomifinKind; results: TomifinResult[] }>(`/api/tomifin/search?${new URLSearchParams({ q: query, kind })}`, { signal }),
  download: (resultId: string, destination: TomifinDestination) => request<{ job: TomifinJob }>('/api/tomifin/download', { method: 'POST', body: JSON.stringify({ resultId, destination }) }),
  downloads: (signal?: AbortSignal) => request<{ jobs: TomifinJob[] }>('/api/tomifin/downloads', { signal }),
  control: (id: string, action: 'pause' | 'resume' | 'cancel') => request<{ job?: TomifinJob; cancelled?: boolean; filesDeleted?: boolean }>(`/api/tomifin/downloads/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
}

export function formatSize(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** power
  return `${power === 0 ? value : value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[power]}`
}

export function formatSpeed(bytesPerSecond: number | null | undefined) {
  return bytesPerSecond ? `${formatSize(bytesPerSecond)}/s` : '—'
}

export function formatEta(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hr ${minutes % 60} min`
  return `${Math.round(hours / 24)} days`
}
