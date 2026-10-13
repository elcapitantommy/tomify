import type { RecoveryItem, RecoveryMetadataChoices } from './recovery'
import { useAuth } from '../stores/auth'

function headers(json = false): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to use Recovery.')
  return {
    'x-tomify-user': session.username,
    'x-tomify-token': session.token,
    'x-tomify-salt': session.salt,
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...headers(Boolean(init.body)), ...init.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || body.error || 'Recovery request failed.')
  return body
}

export const recoveryApi = {
  list: () => request<{ items: RecoveryItem[]; backends: Array<{ id: string; label: string; available: boolean; authentication?: 'configured' | 'not-configured' | 'unavailable'; reason?: string }> }>('/api/recovery'),
  add: (input: { artist: string; title: string; album?: string; duration?: number; trackNumber?: number }) => request<{ item: RecoveryItem }>('/api/recovery', { method: 'POST', body: JSON.stringify(input) }),
  search: (id: string) => request<{ item: RecoveryItem }>(`/api/recovery/${encodeURIComponent(id)}/search`, { method: 'POST', body: JSON.stringify({ backend: 'youtube' }) }),
  select: (id: string, candidateId: string) => request<{ item: RecoveryItem }>(`/api/recovery/${encodeURIComponent(id)}/select`, { method: 'POST', body: JSON.stringify({ candidateId }) }),
  acquire: (id: string, candidateId: string, rightsBasis: string, metadataChoices: RecoveryMetadataChoices, artworkCandidateId: string | null) => request<{ item: RecoveryItem }>(`/api/recovery/${encodeURIComponent(id)}/acquire`, { method: 'POST', body: JSON.stringify({ candidateId, rightsBasis, metadataChoices, artworkCandidateId, confirmedAuthorised: true }) }),
  updateStatus: (id: string, status: string) => request<{ item: RecoveryItem }>(`/api/recovery/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  delete: (id: string) => request<{ deleted: true; filesRemoved: boolean }>(`/api/recovery/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
