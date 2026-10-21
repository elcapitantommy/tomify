import { useEffect, useRef, useState } from 'react'
import { Check, CirclePlus, ListMusic, LoaderCircle, Plus } from 'lucide-react'
import { useApi } from '../lib/api-context'
import type { Playlist } from '../types'
import { loadPlaylistShares } from '../lib/playlist-sharing'
import { collaboratorApi, type SharedPlaylist } from '../lib/playlist-shares'

type Props = { songIds: string[]; label: string; variant?: 'icon' | 'button' }

// Menu for adding one track or a whole album to one of the signed-in account's Navidrome playlists, or a new one.
export function AddToPlaylist({ songIds, label, variant = 'icon' }: Props) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  // Other people's playlists they let this account edit.
  const [shared, setShared] = useState<SharedPlaylist[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setPlaylists(null); setMessage(null); setNaming(false); setName('')
    setShared([])
    void loadPlaylistShares().then((shares) => { if (active) setShared((shares?.sharedWithMe ?? []).filter((item) => item.kind === 'navidrome' && item.canEdit)) })
    api.playlists().then((value) => { if (active) setPlaylists(value) }).catch((reason) => { if (active) { setPlaylists([]); setMessage({ text: reason instanceof Error ? reason.message : 'Playlists could not be loaded.', error: true }) } })
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => { active = false; document.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape) }
  }, [open, api])

  const count = songIds.length === 1 ? 'Track' : `${songIds.length} tracks`
  async function add(playlist: Pick<Playlist, 'id' | 'name'>, collaborative = false) {
    setBusy(playlist.id); setMessage(null)
    try { await (collaborative ? collaboratorApi.add(playlist.id, songIds) : api.addToPlaylist(playlist.id, songIds)); setMessage({ text: `${count} added to ${playlist.name}.`, error: false }) }
    catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : 'Could not add to the playlist.', error: true }) }
    finally { setBusy(null) }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy('new'); setMessage(null)
    try {
      const playlist = await api.createPlaylist(trimmed, songIds)
      setPlaylists((value) => [...(value ?? []), playlist]); setNaming(false); setName('')
      setMessage({ text: `${count} added to ${playlist.name}.`, error: false })
    } catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : 'Could not create the playlist.', error: true }) }
    finally { setBusy(null) }
  }

  return <div className="add-to-playlist" ref={container}>
    {variant === 'icon'
      ? <button type="button" className="icon-button add-to-playlist-toggle" onClick={() => setOpen(!open)} aria-label={`Add ${label} to a playlist`} aria-expanded={open} title="Add to playlist"><CirclePlus/></button>
      : <button type="button" className="button secondary" onClick={() => setOpen(!open)} aria-expanded={open}><Plus/>Add to playlist</button>}
    {open && <div className="add-to-playlist-menu" role="menu" aria-label="Add to playlist">
      <strong>Add to playlist</strong>
      {playlists === null && <p><LoaderCircle className="spin"/>Loading playlists…</p>}
      {playlists?.map((playlist) => <button type="button" role="menuitem" key={playlist.id} disabled={busy !== null} onClick={() => void add(playlist)}>
        {busy === playlist.id ? <LoaderCircle className="spin"/> : <ListMusic/>}<span>{playlist.name}</span>
      </button>)}
      {playlists && shared.length > 0 && <small>Shared with you</small>}
      {playlists && shared.map((playlist) => <button type="button" role="menuitem" key={`shared:${playlist.playlistId}`} disabled={busy !== null} onClick={() => void add({ id: playlist.playlistId, name: playlist.name }, true)}>
        {busy === playlist.playlistId ? <LoaderCircle className="spin"/> : <ListMusic/>}<span>{playlist.name} · {playlist.owner}</span>
      </button>)}
      {playlists && (naming
        ? <form onSubmit={(event) => void create(event)}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" aria-label="New playlist name" maxLength={200}/><button type="submit" className="button primary" disabled={busy !== null || !name.trim()}>{busy === 'new' ? <LoaderCircle className="spin"/> : <Check/>}Create</button></form>
        : <button type="button" role="menuitem" disabled={busy !== null} onClick={() => setNaming(true)}><Plus/><span>New playlist</span></button>)}
      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'add-to-playlist-error' : undefined}>{message.text}</p>}
    </div>}
  </div>
}
