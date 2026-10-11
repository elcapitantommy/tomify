import { create } from 'zustand'
import type { ReleaseOverride, ReleaseType } from '../lib/release-metadata'
import { useAuth } from './auth'

type CloudStatus = 'checking' | 'cloud' | 'unavailable'

interface ReleaseMetadataState {
  overrides: Record<string, ReleaseOverride>
  cloudStatus: CloudStatus
  load(): Promise<void>
  save(albumId: string, patch: { releaseType?: ReleaseType; releaseDate?: string | null }): Promise<boolean>
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

      const body = await response.json() as { items?: Array<{ albumId: string; releaseType: ReleaseType; releaseDate?: string | null; updatedAt?: string }> }
      const remote = Object.fromEntries((body.items ?? []).map((item) => [item.albumId, {
        releaseType: item.releaseType,
        releaseDate: item.releaseDate ?? null,
        updatedAt: item.updatedAt,
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

      set((state) => ({
        overrides: { ...state.overrides, [albumId]: { ...state.overrides[albumId], ...patch, releaseType } },
        cloudStatus: 'cloud',
      }))
      return true
    } catch {
      set({ cloudStatus: 'unavailable' })
      return false
    }
  },
}))
