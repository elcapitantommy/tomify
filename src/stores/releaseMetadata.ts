import { create } from 'zustand'
import type { Album } from '../types'
import { releaseTitleHint, type ReleaseOverride, type ReleaseType } from '../lib/release-metadata'
import { useAuth } from './auth'

type CloudStatus = 'checking' | 'cloud' | 'unavailable'

interface ReleaseMetadataState {
  overrides: Record<string, ReleaseOverride>
  cloudStatus: CloudStatus
  load(): Promise<void>
  save(albumId: string, patch: { releaseType?: ReleaseType; releaseDate?: string | null }): Promise<boolean>
  enrich(album: Album, force?: boolean, replaceManual?: boolean): Promise<boolean>
  enrichMany(albums: Album[], limit?: number): Promise<void>
}

function authHeaders(): HeadersInit | undefined {
  const session = useAuth.getState().session
  if (!session) return undefined
  return {
    'x-tomify-user': session.username,
    'x-tomify-token': session.token,
    'x-tomify-salt': session.salt,
  }
}

if (typeof window !== 'undefined') {
  window.localStorage.removeItem('tomify-release-metadata')
}

const attemptedThisSession = new Set<string>()
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

export const useReleaseMetadata = create<ReleaseMetadataState>((set, get) => ({
  overrides: {},
  cloudStatus: 'checking',

  load: async () => {
    const headers = authHeaders()
    if (!headers) {
      set({ overrides: {}, cloudStatus: 'unavailable' })
      return
    }

    set({ cloudStatus: 'checking' })
    try {
      const response = await window.fetch('/api/release-meta', { headers })
      if (!response.ok) {
        set({ overrides: {}, cloudStatus: 'unavailable' })
        return
      }

      const body = await response.json() as { items?: Array<{ albumId: string; releaseType: ReleaseType; releaseDate?: string | null; updatedAt?: string; source?: 'manual' | 'musicbrainz'; musicBrainzId?: string | null; matchScore?: number | null }> }
      const remote = Object.fromEntries((body.items ?? []).map((item) => [item.albumId, {
        releaseType: item.releaseType,
        releaseDate: item.releaseDate ?? null,
        updatedAt: item.updatedAt,
        source: item.source,
        musicBrainzId: item.musicBrainzId ?? null,
        matchScore: item.matchScore ?? null,
      }]))
      set({ overrides: remote, cloudStatus: 'cloud' })
    } catch {
      set({ overrides: {}, cloudStatus: 'unavailable' })
    }
  },

  save: async (albumId, patch) => {
    const headers = authHeaders()
    const existing = get().overrides[albumId]
    const releaseType = patch.releaseType ?? existing?.releaseType
    if (!headers || !releaseType) return false

    try {
      const response = await window.fetch('/api/release-meta/' + encodeURIComponent(albumId), {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...existing, ...patch, releaseType }),
      })
      if (!response.ok) {
        set({ cloudStatus: 'unavailable' })
        return false
      }

      const body = await response.json() as { item?: ReleaseOverride }
      set((state) => ({
        overrides: { ...state.overrides, [albumId]: body.item ?? { ...state.overrides[albumId], ...patch, releaseType, source: 'manual' } },
        cloudStatus: 'cloud',
      }))
      return true
    } catch {
      set({ cloudStatus: 'unavailable' })
      return false
    }
  },

  enrich: async (album, force = false, replaceManual = false) => {
    const existing = get().overrides[album.id]
    if (!force && (existing || attemptedThisSession.has(album.id))) return false
    if (force && existing?.source === 'manual' && !replaceManual) return false
    const headers = authHeaders()
    if (!headers || get().cloudStatus !== 'cloud') return false
    attemptedThisSession.add(album.id)

    try {
      const response = await window.fetch('/api/release-meta/enrich', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          albumId: album.id,
          name: album.name,
          artist: album.artist,
          musicBrainzId: album.musicBrainzId,
          year: album.year,
          force,
          replaceManual,
        }),
      })
      if (!response.ok) {
        attemptedThisSession.delete(album.id)
        return false
      }
      const body = await response.json() as { item?: ReleaseOverride & { albumId?: string } }
      if (!body.item?.releaseType) {
        attemptedThisSession.delete(album.id)
        return false
      }
      set((state) => ({ overrides: { ...state.overrides, [album.id]: body.item! } }))
      return true
    } catch {
      attemptedThisSession.delete(album.id)
      return false
    }
  },

  enrichMany: async (albums, limit = 24) => {
    const candidates = albums.filter((album) => !get().overrides[album.id] && !attemptedThisSession.has(album.id)).sort((a, b) => Number(Boolean(releaseTitleHint(b))) - Number(Boolean(releaseTitleHint(a)))).slice(0, limit)
    for (const album of candidates) {
      await get().enrich(album)
      await wait(1100)
    }
  },
}))
