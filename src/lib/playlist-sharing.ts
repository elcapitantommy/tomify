import type { NavidromeClient } from './navidrome'
import { playlistShareApi, type PlaylistShares } from './playlist-shares'

// Shares are optional extras: a failure to load them must not hide the account's own playlists.
export function loadPlaylistShares(): Promise<PlaylistShares | null> { return playlistShareApi.list().catch(() => null) }

// Recipients read a shared Navidrome playlist with their own credentials, so it has to be public in Navidrome while shared.
// `editors` are the recipients who may also add, remove and reorder songs.
export async function saveNavidromePlaylistShares(api: Pick<NavidromeClient, 'setPlaylistPublic'>, playlistId: string, users: string[], editors: string[] = []) {
  if (users.length) await api.setPlaylistPublic(playlistId, true)
  const saved = await playlistShareApi.update('navidrome', playlistId, users, editors)
  if (!saved.sharedWith.length) await api.setPlaylistPublic(playlistId, false)
  return { sharedWith: saved.sharedWith, editors: saved.editors ?? [] }
}

export async function saveImportedPlaylistShares(playlistId: string, users: string[]) { return (await playlistShareApi.update('imported', playlistId, users)).sharedWith }
