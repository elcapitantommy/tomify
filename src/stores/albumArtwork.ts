import { create } from 'zustand'
import type { Album } from '../types'
import { useAuth } from './auth'
import { prepareArtworkUpload } from '../lib/artwork-upload'

export type ArtworkProvider = 'apple' | 'deezer' | 'spotify'

export interface AlbumArtworkOverride {
  albumId: string
  provider: ArtworkProvider | 'library' | 'upload'
  providerId?: string | null
  url?: string | null
  width?: number | null
  height?: number | null
  confidence?: number | null
  source: 'auto' | 'manual'
  providerAlbum?: string | null
  providerArtist?: string | null
  storeUrl?: string | null
  updatedAt?: string | null
}

export interface AlbumArtworkCandidate {
  id: string
  provider: ArtworkProvider
  providerLabel?: string
  providerId: string
  url: string
  previewUrl?: string
  width?: number | null
  height?: number | null
  confidence: number
  artist?: string | null
  album?: string | null
  releaseDate?: string | null
  storeUrl?: string | null
  quality?: 'high' | 'preferred' | 'fallback'
}

export type AutoArtworkResult = 'applied' | 'unchanged' | 'manual-choice' | 'low-confidence' | 'no-match' | 'failed'
export interface AutoArtworkOutcome { result: AutoArtworkResult | 'rate-limited'; retryAfter?: number; message?: string }
export interface ArtworkUpgradeProgress { done: number; total: number; applied: number; unchanged: number; noMatch: number; lowConfidence: number; failed: number; skipped?: number; waitingSeconds?: number; lastError?: string; stopped?: boolean }

type Status = 'checking' | 'ready' | 'unavailable'
export interface ArtworkUpgradeRun { running: boolean; progress: ArtworkUpgradeProgress | null; error: string | null }

interface AlbumArtworkState {
  overrides: Record<string, AlbumArtworkOverride>
  status: Status
  providers: ArtworkProvider[]
  upgrade: ArtworkUpgradeRun
  load(): Promise<void>
  lookup(album: Album): Promise<AlbumArtworkCandidate[]>
  select(albumId: string, candidate: AlbumArtworkCandidate | 'library'): Promise<void>
  reset(albumId: string): Promise<void>
  upload(albumId: string, file: File): Promise<void>
  auto(album: Album): Promise<AutoArtworkOutcome>
  upgradeMany(albums: Album[], onProgress?: (progress: ArtworkUpgradeProgress) => void, signal?: AbortSignal): Promise<ArtworkUpgradeProgress>
  startUpgrade(loadAlbums: (signal: AbortSignal) => Promise<Album[]>): Promise<void>
  stopUpgrade(): void
}

function headers(): Record<string, string> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to change album artwork.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await window.fetch('/api/album-artwork/' + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw Object.assign(new Error(result.message || result.error || 'Album artwork request failed.'), { code: result.error, retryAfter: (result as { retryAfter?: number }).retryAfter })
  return result
}

const albumInput = (album: Album) => ({ albumId: album.id, name: album.name, artist: album.artist, year: album.year })
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
// Apple's catalogue allows roughly 20 searches a minute, so the bulk run spaces albums to stay inside it.
export const upgradeIntervalMs = 3000
let upgradeController: AbortController | null = null

// Albums the bulk run checked without finding a confident match, so a restarted run (after an update or refresh) skips them.
// Bump the matcher version when the Worker's matching improves (v2: disc markers such as " - Disc 2"
// are ignored) so albums that found nothing before are searched again on the next run.
export const artworkMatcherVersion = 2
const checkedKey = () => `tomify-artwork-checked:v${artworkMatcherVersion}:` + (useAuth.getState().session?.username ?? '')
const legacyCheckedKeys = () => ['tomify-artwork-checked:', ...Array.from({ length: artworkMatcherVersion - 2 }, (_, index) => `tomify-artwork-checked:v${index + 2}:`)].map((prefix) => prefix + (useAuth.getState().session?.username ?? ''))
const recheckAfterMs = 30 * 24 * 60 * 60 * 1000

function readChecked(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(checkedKey()) ?? '{}') as Record<string, number>
    return Object.fromEntries(Object.entries(stored).filter(([, at]) => typeof at === 'number' && Date.now() - at < recheckAfterMs))
  } catch { return {} }
}

function rememberChecked(albumId: string) {
  try { for (const key of legacyCheckedKeys()) localStorage.removeItem(key) } catch { /* storage unavailable */ }
  try { localStorage.setItem(checkedKey(), JSON.stringify({ ...readChecked(), [albumId]: Date.now() })) } catch { /* storage unavailable: the album is simply checked again next run */ }
}

export function albumArtworkUrl(override?: AlbumArtworkOverride) {
  return override && override.provider !== 'library' && override.url ? override.url : undefined
}

export const useAlbumArtwork = create<AlbumArtworkState>((set, get) => ({
  overrides: {},
  status: 'checking',
  providers: [],
  upgrade: { running: false, progress: null, error: null },

  load: async () => {
    set({ status: 'checking' })
    try {
      const response = await window.fetch('/api/album-artwork', { headers: headers() })
      if (!response.ok) { set({ overrides: {}, status: 'unavailable', providers: [] }); return }
      const body = await response.json() as { items?: AlbumArtworkOverride[]; providers?: ArtworkProvider[] }
      set({ overrides: Object.fromEntries((body.items ?? []).map((item) => [item.albumId, item])), status: 'ready', providers: body.providers ?? [] })
    } catch {
      set({ overrides: {}, status: 'unavailable', providers: [] })
    }
  },

  lookup: async (album) => (await post<{ candidates: AlbumArtworkCandidate[] }>('lookup', albumInput(album))).candidates ?? [],

  select: async (albumId, candidate) => {
    const { item } = await post<{ item: AlbumArtworkOverride }>('select', candidate === 'library' ? { albumId, provider: 'library' } : { albumId, candidate })
    set((state) => ({ overrides: { ...state.overrides, [albumId]: item } }))
  },

  upload: async (albumId, file) => {
    const prepared = await prepareArtworkUpload(file)
    const { item } = await post<{ item: AlbumArtworkOverride }>('upload', { albumId, ...prepared })
    set((state) => ({ overrides: { ...state.overrides, [albumId]: item } }))
  },

  reset: async (albumId) => {
    await post('reset', { albumId })
    set((state) => { const overrides = { ...state.overrides }; delete overrides[albumId]; return { overrides } })
  },

  auto: async (album) => {
    try {
      const result = await post<{ item?: AlbumArtworkOverride | null; applied: boolean; reason?: AutoArtworkResult }>('auto', albumInput(album))
      if (result.applied && result.item) set((state) => ({ overrides: { ...state.overrides, [album.id]: result.item! } }))
      return { result: result.applied ? 'applied' : result.reason ?? 'no-match' }
    } catch (error) {
      const failure = error as Error & { code?: string; retryAfter?: number }
      if (failure.code === 'rate-limited') return { result: 'rate-limited', retryAfter: failure.retryAfter ?? 5 }
      return { result: 'failed', message: failure.message }
    }
  },

  upgradeMany: async (albums, onProgress, signal) => {
    // Albums that already have artwork (upgraded or chosen by hand) or were checked recently without a match are skipped,
    // so restarting the run after an update picks up where it left off. The album page can still look up any album.
    const checked = readChecked()
    const pending = albums.filter((album) => !get().overrides[album.id] && !checked[album.id])
    const progress: ArtworkUpgradeProgress = { done: 0, total: pending.length, applied: 0, unchanged: 0, noMatch: 0, lowConfidence: 0, failed: 0 }
    if (albums.length > pending.length) progress.skipped = albums.length - pending.length
    onProgress?.({ ...progress })
    let consecutiveFailures = 0
    for (const album of pending) {
      if (signal?.aborted) break
      let outcome = await get().auto(album)
      // Catalogue rate limits are waited out and the same album retried, rather than counted as misses.
      for (let attempt = 0; outcome.result === 'rate-limited' && attempt < 5 && !signal?.aborted; attempt += 1) {
        const seconds = Math.min(60, outcome.retryAfter ?? 5)
        onProgress?.({ ...progress, waitingSeconds: seconds })
        await wait(seconds * 1000)
        outcome = await get().auto(album)
      }
      if (signal?.aborted) break
      progress.done += 1
      if (outcome.result === 'no-match' || outcome.result === 'low-confidence') rememberChecked(album.id)
      if (outcome.result === 'applied') progress.applied += 1
      else if (outcome.result === 'no-match') progress.noMatch += 1
      else if (outcome.result === 'low-confidence') progress.lowConfidence += 1
      else if (outcome.result === 'unchanged' || outcome.result === 'manual-choice') progress.unchanged += 1
      else { progress.failed += 1; progress.lastError = outcome.message ?? 'The artwork catalogues kept rate limiting Tomify.' }
      consecutiveFailures = outcome.result === 'failed' || outcome.result === 'rate-limited' ? consecutiveFailures + 1 : 0
      onProgress?.({ ...progress })
      // Five failures in a row means the catalogues are refusing every request; stop instead of failing the whole library.
      if (consecutiveFailures >= 5) { progress.stopped = true; break }
      await wait(upgradeIntervalMs)
    }
    return progress
  },

  // The run lives in the store, not the Settings page, so it keeps going while you browse.
  startUpgrade: async (loadAlbums) => {
    if (get().upgrade.running) return
    upgradeController = new AbortController()
    const { signal } = upgradeController
    set({ upgrade: { running: true, progress: null, error: null } })
    try {
      const albums = await loadAlbums(signal)
      const progress = await get().upgradeMany(albums, (next) => set({ upgrade: { running: true, progress: next, error: null } }), signal)
      set({ upgrade: { running: false, progress, error: null } })
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError'
      set((state) => ({ upgrade: { running: false, progress: state.upgrade.progress, error: aborted ? null : reason instanceof Error ? reason.message : 'The artwork upgrade stopped.' } }))
    } finally {
      upgradeController = null
    }
  },

  stopUpgrade: () => {
    upgradeController?.abort()
    set((state) => ({ upgrade: { ...state.upgrade, running: false } }))
  },
}))
