import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ReleaseOverride, ReleaseType } from '../lib/release-metadata'
import { useAuth } from './auth'

type CloudStatus = 'checking' | 'cloud' | 'local'

interface ReleaseMetadataState {
  overrides: Record<string, ReleaseOverride>
  cloudStatus: CloudStatus
  load(): Promise<void>
  save(albumId: string, patch: { releaseType?: ReleaseType; releaseDate?: string | null }): Promise<void>
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

export const useReleaseMetadata = create<ReleaseMetadataState>()(persist((set, get) => ({
  overrides: {},
  cloudStatus: 'checking',
  load: async () => {
    const headers = authHeaders()
    if (!headers) return
    set({ cloudStatus: 'checking' })
    try {
      const response = await window.fetch('/api/release-meta', { headers })
      if (!response.ok) {
        set({ cloudStatus: 'local' })
        return
      }
      const body = await response.json() as { items?: Array<{ albumId: string; releaseType: ReleaseType; releaseDate?: string | null; updatedAt?: string }> }
      const remote = Object.fromEntries((body.items ?? []).map((item) => [item.albumId, {
        releaseType: item.releaseType,
        releaseDate: item.releaseDate ?? null,
        updatedAt: item.updatedAt,
      }]))
      set((state) => ({ overrides: { ...state.overrides, ...remote }, cloudStatus: 'cloud' }))
    } catch {
      set({ cloudStatus: 'local' })
    }
  },
  save: async (albumId, patch) => {
    const next = { ...get().overrides[albumId], ...patch }
    set((state) => ({ overrides: { ...state.overrides, [albumId]: next } }))
    const headers = authHeaders()
    if (!headers) return
    try {
      const response = await window.fetch('/api/release-meta/' + encodeURIComponent(albumId), {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      set({ cloudStatus: response.ok ? 'cloud' : 'local' })
    } catch {
      set({ cloudStatus: 'local' })
    }
  },
}), {
  name: 'tomify-release-metadata',
  partialize: ({ overrides }) => ({ overrides }),
}))
