export type TomifinDestination = 'family' | 'private'
export type TomifinKind = 'video' | 'movies' | 'tv'
export type TomifinStatus = 'queued' | 'downloading' | 'stalled' | 'paused' | 'completed' | 'failed'

export interface TomifinQuality { resolution: string | null; hdr: string | null; codec: string | null; source: string | null }
export type TomifinResultType = 'torrent' | 'usenet'
// Torrents carry seeders and leechers; NZBs carry no swarm figures, only the indexer's age and grab count.
export interface TomifinResult {
  id: string; title: string; source: string; size: number | null; seeders: number | null; leechers: number | null
  type: TomifinResultType; linkType: 'magnet' | 'torrent-file' | 'nzb'; detailsUrl: string | null; quality: TomifinQuality
  grabs?: number | null; ageDays?: number | null; origin?: 'search' | 'link'
}
export interface TomifinJob {
  id: string; name: string; destination: TomifinDestination; destinationLabel: string; status: TomifinStatus; message: string | null
  downloader?: 'qbittorrent' | 'sabnzbd'; downloaderLabel?: string; type?: TomifinResultType
  progress: number; downloadSpeed: number | null; uploadSpeed: number | null; downloaded: number | null; size: number | null; eta: number | null
  seeds: number | null; peers: number | null; source: string | null; createdAt: string; canPause: boolean; canResume: boolean; keepsFilesOnCancel: boolean
  // A failed download its downloader can try again (an older agent leaves this out).
  canRetry?: boolean
}
export interface TomifinVpnStatus {
  state: 'connected' | 'connecting' | 'down' | 'unknown'
  qbittorrent: 'connected' | 'firewalled' | 'disconnected' | 'unknown'
  nordvpn: { state: 'connected' | 'disconnected' | 'connecting' | 'unknown'; country: string | null; city: string | null; server: string | null } | null
}
export interface TomifinServiceStatus {
  available: boolean; problem: string | null; destinations: Array<{ id: TomifinDestination; label: string; available: boolean }>
  downloaders?: { torrent: { available: boolean }; usenet: { available: boolean; problem: string | null; search?: { available: boolean; providers: string[]; problem: string | null } } }
}
export type TomifinDetected = 'magnet' | 'torrent' | 'nzb'
export type TomifinLinkInput = { link: string } | { file: { name: string; data: string } }

export const DESTINATIONS: Record<TomifinDestination, { label: string; path: string }> = {
  family: { label: 'Family', path: '/media/family' },
  private: { label: 'Private', path: '/media/private' },
}

export type TomifinJobAction = 'pause' | 'resume' | 'retry' | 'cancel'

export class TomifinRequestError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) { super(message); this.name = 'TomifinRequestError'; this.status = status; this.code = code }
}

// The Jellyfin session lives in an HttpOnly cookie the page cannot read; the browser sends it with each request.
// x-tomifin marks requests from this page, which the Worker requires for anything that changes state.
function headers(json: boolean): HeadersInit {
  return { 'x-tomifin': '1', ...(json ? { 'content-type': 'application/json' } : {}) }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...headers(Boolean(init.body)), ...init.headers } }) }
  catch (error) {
    if (error instanceof TomifinRequestError || (error instanceof DOMException && error.name === 'AbortError')) throw error
    throw new TomifinRequestError('Tomify could not be reached. Check your connection and try again.', 0, 'network')
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new TomifinRequestError(body.message || body.error || `Request failed (HTTP ${response.status}).`, response.status, body.error || 'error')
  return body
}

export const tomifinApi = {
  session: (signal?: AbortSignal) => request<{ user: { name: string } }>('/api/tomifin/session', { signal }),
  signIn: (username: string, password: string) => request<{ user: { name: string } }>('/api/tomifin/session', { method: 'POST', body: JSON.stringify({ username, password }) }),
  signOut: () => request<{ signedOut: true }>('/api/tomifin/session', { method: 'DELETE' }),
  status: (signal?: AbortSignal) => request<TomifinServiceStatus>('/api/tomifin/status', { signal }),
  vpn: (signal?: AbortSignal) => request<TomifinVpnStatus>('/api/tomifin/vpn', { signal }),
  search: (query: string, kind: TomifinKind, signal?: AbortSignal) => request<{ query: string; kind: TomifinKind; results: TomifinResult[]; warnings?: string[]; usenet?: boolean }>(`/api/tomifin/search?${new URLSearchParams({ q: query, kind })}`, { signal }),
  // Checks a pasted link or an uploaded file on the media server; it comes back as a result to queue like any other.
  addLink: (input: TomifinLinkInput) => request<{ detected: TomifinDetected; result: TomifinResult }>('/api/tomifin/link', { method: 'POST', body: JSON.stringify(input) }),
  download: (resultId: string, destination: TomifinDestination) => request<{ job: TomifinJob }>('/api/tomifin/download', { method: 'POST', body: JSON.stringify({ resultId, destination }) }),
  downloads: (signal?: AbortSignal) => request<{ jobs: TomifinJob[] }>('/api/tomifin/downloads', { signal }),
  control: (id: string, action: TomifinJobAction) => request<{ job?: TomifinJob; cancelled?: boolean; filesDeleted?: boolean }>(`/api/tomifin/downloads/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
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

export function formatAge(days: number | null | undefined) {
  if (days == null || !Number.isFinite(days) || days < 0) return '—'
  if (days < 1) return 'Today'
  if (days < 60) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`
  if (days < 730) return `${Math.round(days / 30)} months`
  return `${Math.round(days / 365)} years`
}

// A chosen .torrent or .nzb file as base64, for Add link.
export function readFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })
}
