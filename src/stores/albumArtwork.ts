import { create } from 'zustand'
import type { Album } from '../types'
import { useAuth } from './auth'

export interface AlbumArtworkOverride {
  albumId: string
  provider: 'spotify' | 'library'
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
  provider: 'spotify'
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
export interface ArtworkUpgradeProgress { done: number; total: number; applied: number; skipped: number; failed: number }

type Status = 'checking' | 'ready' | 'unavailable'

interface AlbumArtworkState {
  overrides: Record<string, AlbumArtworkOverride>
  status: Status
  spotifyAvailable: boolean
  load(): Promise<void>
  lookup(album: Album): Promise<AlbumArtworkCandidate[]>
  select(albumId: string, candidate: AlbumArtworkCandidate | 'library'): Promise<void>
  reset(albumId: string): Promise<void>
  auto(album: Album): Promise<AutoArtworkResult>
  upgradeMany(albums: Album[], onProgress?: (progress: ArtworkUpgradeProgress) => void, signal?: AbortSignal): Promise<ArtworkUpgradeProgress>
}

function headers(): Record<string, string> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to change album artwork.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await window.fetch('/api/album-artwork/' + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw Object.assign(new Error(result.message || result.error || 'Album artwork request failed.'), { code: result.error })
  return result
}

const albumInput = (album: Album) => ({ albumId: album.id, name: album.name, artist: album.artist, year: album.year })
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

export function albumArtworkUrl(override?: AlbumArtworkOverride) {
  return override?.provider === 'spotify' && override.url ? override.url : undefined
}

export const useAlbumArtwork = create<AlbumArtworkState>((set, get) => ({
  overrides: {},
  status: 'checking',
  spotifyAvailable: false,

  load: async () => {
    set({ status: 'checking' })
    try {
      const response = await window.fetch('/api/album-artwork', { headers: headers() })
      if (!response.ok) { set({ overrides: {}, status: 'unavailable', spotifyAvailable: false }); return }
      const body = await response.json() as { items?: AlbumArtworkOverride[]; spotifyAvailable?: boolean }
      set({ overrides: Object.fromEntries((body.items ?? []).map((item) => [item.albumId, item])), status: 'ready', spotifyAvailable: Boolean(body.spotifyAvailable) })
    } catch {
      set({ overrides: {}, status: 'unavailable', spotifyAvailable: false })
    }
  },

  lookup: async (album) => (await post<{ candidates: AlbumArtworkCandidate[] }>('lookup', albumInput(album))).candidates ?? [],

  select: async (albumId, candidate) => {
    const { item } = await post<{ item: AlbumArtworkOverride }>('select', candidate === 'library' ? { albumId, provider: 'library' } : { albumId, candidate })
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
      return result.applied ? 'applied' : result.reason ?? 'no-match'
    } catch {
      return 'failed'
    }
  },

  upgradeMany: async (albums, onProgress, signal) => {
    // Albums with a manual choice are left alone; everything else is re-checked so better matches can replace earlier ones.
    const pending = albums.filter((album) => get().overrides[album.id]?.source !== 'manual')
    const progress: ArtworkUpgradeProgress = { done: 0, total: pending.length, applied: 0, skipped: 0, failed: 0 }
    onProgress?.({ ...progress })
    for (const album of pending) {
      if (signal?.aborted) break
      const result = await get().auto(album)
      progress.done += 1
      if (result === 'applied') progress.applied += 1
      else if (result === 'failed') progress.failed += 1
      else progress.skipped += 1
      onProgress?.({ ...progress })
      await wait(250)
    }
    return progress
  },
}))
