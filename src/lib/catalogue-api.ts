import type { CataloguePlaylist, CatalogueResolution, CataloguePlaylistDiff, CataloguePlaylistDraft, CataloguePlaylistSummary } from './catalogue-import'
import { useAuth } from '../stores/auth'

function authHeaders(json = false): HeadersInit { const session = useAuth.getState().session; if (!session) throw new Error('Sign in to import playlists.'); return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, ...(json ? { 'content-type': 'application/json' } : {}) } }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(path, { ...init, headers: { ...authHeaders(Boolean(init.body)), ...init.headers } }); const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }; if (!response.ok) throw new Error(body.message || body.error || 'Playlist import request failed.'); return body }

export const catalogueApi = {
  spotifyStatus: () => request<{ configured: boolean; connected: boolean; updatedAt?: string | null }>('/api/catalogue-auth/spotify/status'),
  connectSpotify: () => request<{ authorizationUrl: string }>('/api/catalogue-auth/spotify/start', { method: 'POST' }),
  disconnectSpotify: () => request<{ disconnected: true }>('/api/catalogue-auth/spotify', { method: 'DELETE' }),
  analyseSpotify: (url: string) => request<{ playlist: CataloguePlaylistDraft; existingPlaylists: CataloguePlaylist[]; diff: CataloguePlaylistDiff | null }>('/api/catalogue-imports/spotify/analyse', { method: 'POST', body: JSON.stringify({ url }) }),
  list: () => request<{ playlists: CataloguePlaylistSummary[] }>('/api/catalogue-playlists'),
  get: (id: string) => request<{ playlist: CataloguePlaylist }>(`/api/catalogue-playlists/${encodeURIComponent(id)}`),
  create: (playlist: CataloguePlaylistDraft, createRecovery: boolean) => request<{ playlist: CataloguePlaylist }>('/api/catalogue-playlists', { method: 'POST', body: JSON.stringify({ playlist, createRecovery, mode: 'copy' }) }),
  update: (id: string, playlist: CataloguePlaylistDraft, createRecovery: boolean) => request<{ playlist: CataloguePlaylist }>(`/api/catalogue-playlists/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ playlist, createRecovery }) }),
  resolve: (id: string, items: CatalogueResolution[]) => request<{ playlist: CataloguePlaylist }>(`/api/catalogue-playlists/${encodeURIComponent(id)}/resolve`, { method: 'PATCH', body: JSON.stringify({ items }) }),
}
