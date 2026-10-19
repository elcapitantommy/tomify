import { useAuth } from '../stores/auth'
import { headers } from './inventory-api'
import { NavidromeClient } from './navidrome'

export type LibraryMoveRequest = { kind: 'merge'; keep: string; paths: string[]; label?: string } | { kind: 'promote'; master: string; recovery: string; label?: string }
export type LibraryMove = { from: string; to: string; path?: string }
export type LibraryMovePlan = { kind: string; label: string; moves: LibraryMove[]; conflicts: string[]; sizes: Record<string, number> }
export type LibraryMoveJournal = { id: string; createdAt: string; kind: string; label?: string; moves: LibraryMove[]; status: 'applying' | 'applied' | 'rolled-back' | 'undone'; error?: string | null }

export class LibraryMovesUnavailableError extends Error {}

async function request<T>(action: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/api/library-moves/${action}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (response.status === 404 && result.error === 'library-moves-not-available') throw new LibraryMovesUnavailableError(result.message || 'Library moves are unavailable.')
  if (!response.ok) throw new Error(result.message || result.error || 'The library move failed.')
  return result
}

export const planLibraryMove = (move: LibraryMoveRequest) => request<LibraryMovePlan>('plan', move)
export const applyLibraryMove = (move: LibraryMoveRequest, relink: Record<string, string>) => request<{ journal: LibraryMoveJournal; relinked: number }>('apply', { ...move, relink })
export const undoLibraryMove = (id: string) => request<{ journal: LibraryMoveJournal }>('undo', { id })
export const listLibraryMoves = async () => (await request<{ moves: LibraryMoveJournal[] }>('list')).moves

const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

// Navidrome reports its own song paths, not the real ones, so each copy is found by title and matched on its exact
// file size and extension. A copy matching no song, or a song matching more than one copy, is left out.
export async function matchSongIds(api: NavidromeClient, label: string, sizes: Record<string, number>): Promise<Record<string, string>> {
  const paths = Object.keys(sizes)
  if (!paths.length) return {}
  const title = label.split(' — ').slice(1).join(' — ') || label
  const { tracks } = await api.search(title)
  const ids: Record<string, string> = {}
  for (const path of paths) {
    const songs = tracks.filter((track) => track.size === sizes[path] && (track.suffix || '').toLowerCase() === extension(path))
    if (songs.length === 1) ids[path] = songs[0].id
  }
  const used = Object.values(ids)
  return Object.fromEntries(Object.entries(ids).filter(([, id]) => used.indexOf(id) === used.lastIndexOf(id)))
}

// Song ids moved away mapped to the id that stays. A promotion keeps the master's path, and so its song id, only
// when the extension is unchanged; otherwise Navidrome gives the promoted file a new id on its next scan.
export function relinkMap(move: LibraryMoveRequest, ids: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {}
  if (move.kind === 'merge') {
    const kept = ids[move.keep]
    if (kept) for (const path of move.paths) if (path !== move.keep && ids[path] && ids[path] !== kept) map[ids[path]] = kept
  } else if (extension(move.master) === extension(move.recovery) && ids[move.master] && ids[move.recovery] && ids[move.master] !== ids[move.recovery]) {
    map[ids[move.recovery]] = ids[move.master]
  }
  return map
}

// Replaces moved-away songs in the signed-in administrator's own Navidrome playlists. Returns the playlists changed.
export async function relinkOwnPlaylists(api: NavidromeClient, map: Record<string, string>): Promise<number> {
  if (!Object.keys(map).length) return 0
  let changed = 0
  for (const summary of await api.playlists()) {
    const entries = (await api.playlist(summary.id)).entry ?? []
    if (!entries.some((track) => map[track.id])) continue
    await api.replacePlaylistTracks(summary.id, entries.map((track) => map[track.id] ?? track.id))
    changed += 1
  }
  return changed
}

export function navidrome() {
  const session = useAuth.getState().session
  return session ? new NavidromeClient(session) : null
}

// Asks Navidrome for a quick scan so it notices the moved files; its next scheduled scan would find them anyway.
export async function rescanNavidrome() {
  try { await navidrome()?.startScan(false) } catch { /* not needed for the move itself */ }
}
