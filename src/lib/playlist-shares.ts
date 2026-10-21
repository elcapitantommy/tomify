import { useAuth } from '../stores/auth'

export type PlaylistShareKind = 'navidrome' | 'imported'
export interface SharedPlaylist { kind: PlaylistShareKind; playlistId: string; owner: string; name: string; canEdit?: boolean }
export interface PlaylistShares { accounts: string[]; sharedWithMe: SharedPlaylist[]; sharedByMe: Array<{ kind: PlaylistShareKind; playlistId: string; sharedWith: string[]; editors?: string[] }>; collaboration?: boolean }

function authHeaders(json = false): HeadersInit { const session = useAuth.getState().session; if (!session) throw new Error('Sign in to share playlists.'); return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, ...(json ? { 'content-type': 'application/json' } : {}) } }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(path, { ...init, headers: { ...authHeaders(Boolean(init.body)), ...init.headers } }); const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }; if (!response.ok) throw new Error(body.message || body.error || 'Playlist sharing request failed.'); return body }

export const playlistShareApi = {
  list: () => request<PlaylistShares>('/api/playlist-shares'),
  update: (kind: PlaylistShareKind, playlistId: string, users: string[], editors: string[] = []) => request<{ kind: PlaylistShareKind; playlistId: string; sharedWith: string[]; editors?: string[] }>(`/api/playlist-shares/${kind}/${encodeURIComponent(playlistId)}`, { method: 'PUT', body: JSON.stringify({ users, editors }) }),
}

export function sharedWithFor(shares: PlaylistShares | null | undefined, kind: PlaylistShareKind, playlistId: string) { return shares?.sharedByMe.find((entry) => entry.kind === kind && entry.playlistId === playlistId)?.sharedWith ?? [] }
export function shareFromOwner(shares: PlaylistShares | null | undefined, kind: PlaylistShareKind, playlistId: string) { return shares?.sharedWithMe.find((entry) => entry.kind === kind && entry.playlistId === playlistId) ?? null }
export function editorsFor(shares: PlaylistShares | null | undefined, playlistId: string) { return shares?.sharedByMe.find((entry) => entry.kind === 'navidrome' && entry.playlistId === playlistId)?.editors ?? [] }

// Changes to someone else's playlist they let you edit. The Worker makes them as the owner, since Navidrome
// only lets a playlist's owner change it.
const editSongs = (playlistId: string, body: Record<string, unknown>) => request<{ ok: true }>(`/api/playlist-shares/navidrome/${encodeURIComponent(playlistId)}/songs`, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined)
export const collaboratorApi = {
  add: (playlistId: string, songIds: string[]) => editSongs(playlistId, { action: 'add', songIds }),
  remove: (playlistId: string, indexes: number[]) => editSongs(playlistId, { action: 'remove', indexes }),
  replace: (playlistId: string, songIds: string[]) => editSongs(playlistId, { action: 'replace', songIds }),
}
