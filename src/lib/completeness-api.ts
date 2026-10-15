import type { AlbumTracklist, RecoveryLink, ReleaseEdition } from './album-completeness'
import { useAuth } from '../stores/auth'

export interface TracklistResponse { tracklist: AlbumTracklist; editions: ReleaseEdition[]; recovery: Record<string, RecoveryLink> }
export interface TracklistRequest { albumId: string; name: string; artist: string; year?: number; musicBrainzId?: string; localTrackCount: number; releaseId?: string; force?: boolean }

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to check album completeness.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw Object.assign(new Error(result.message || result.error || 'Album completeness request failed.'), { code: result.error })
  return result
}

export const completenessApi = {
  tracklist: (input: TracklistRequest, signal?: AbortSignal) => post<TracklistResponse>('/api/album-completeness/tracklist', input, signal),
  addMissing: (albumId: string, trackKeys: string[]) => post<{ created: number; existing: number; recovery: Record<string, RecoveryLink> }>('/api/album-completeness/recovery', { albumId, trackKeys }),
}
