import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Check, ListMusic, LoaderCircle, Pencil, Play, Shuffle, Trash2, X } from 'lucide-react'
import { ExportPlaylistButton } from '../components/ExportPlaylist'
import { useNavigate, useParams } from 'react-router-dom'
import { SharePlaylist } from '../components/SharePlaylist'
import { CollectionDownloadButton } from '../components/DownloadButton'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { DragHandle } from '../components/DragHandle'
import { ShareLinkButton } from '../components/ShareLink'
import { moveItem } from '../lib/reorder'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { collaboratorApi, editorsFor, shareFromOwner, sharedWithFor } from '../lib/playlist-shares'
import { loadPlaylistShares, saveNavidromePlaylistShares } from '../lib/playlist-sharing'
import { PlayNextButton } from '../components/TrackMenu'
import { usePlayer } from '../stores/player'
import type { Track } from '../types'

const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

export function PlaylistDetail() {
  const api = useApi(); const { id = '' } = useParams(); const navigate = useNavigate()
  const { data, loading, error, retry } = useLoad(async (signal) => { const shares = await loadPlaylistShares(); const playlist = await api.playlist(id, signal, shareFromOwner(shares, 'navidrome', id)?.owner); return { playlist, shares } }, [api, id])
  const [tracks, setTracks] = useState<Track[]>([])
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  useEffect(() => { if (data) { setTracks(data.playlist.entry ?? []); setName(data.playlist.name) } }, [data])

  if (loading) return <div className="page"><SkeletonGrid/></div>; if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>; if (!data) return null
  const { playlist, shares } = data; const owned = api.ownsPlaylist(playlist)
  // Someone the owner lets edit can add, remove and reorder songs; renaming and deleting stay with the owner.
  const collaborator = !owned && Boolean(shareFromOwner(shares, 'navidrome', playlist.id)?.canEdit)
  const canEdit = owned || collaborator
  const songs = owned ? { replace: (songIds: string[]) => api.replacePlaylistTracks(playlist.id, songIds), remove: (indexes: number[]) => api.removeFromPlaylist(playlist.id, indexes) } : { replace: (songIds: string[]) => collaboratorApi.replace(playlist.id, songIds), remove: (indexes: number[]) => collaboratorApi.remove(playlist.id, indexes) }
  const duration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0)

  // Each edit is saved straight away; the list updates first and goes back if the music server refuses.
  async function run(action: string, optimistic: Track[] | null, save: () => Promise<void>) {
    const previous = tracks
    setBusy(action); setEditError(null)
    if (optimistic) setTracks(optimistic)
    try { await save() } catch (reason) { setTracks(previous); setEditError(message(reason, 'The playlist could not be saved.')) } finally { setBusy(null) }
  }
  const moveTo = (from: number, to: number) => {
    const next = moveItem(tracks, from, to)
    if (next === tracks) return
    void run(`move-${from}`, next, () => songs.replace(next.map((item) => item.id)))
  }
  const move = (index: number, offset: number) => moveTo(index, index + offset)
  const remove = (index: number) => void run(`remove-${index}`, tracks.filter((_, position) => position !== index), () => songs.remove([index]))
  async function rename(event: React.FormEvent) {
    event.preventDefault()
    const next = draftName.trim()
    if (!next || next === name) return
    setBusy('rename'); setEditError(null)
    try { await api.renamePlaylist(playlist.id, next); setName(next) } catch (reason) { setEditError(message(reason, 'The playlist could not be renamed.')) } finally { setBusy(null) }
  }
  async function deletePlaylist() {
    setBusy('delete'); setEditError(null)
    try {
      // Clear Tomify shares first so nobody is left with a link to a playlist that no longer exists.
      if (sharedWithFor(shares, 'navidrome', playlist.id).length) await saveNavidromePlaylistShares(api, playlist.id, [], [])
      await api.deletePlaylist(playlist.id)
      navigate('/playlists')
    } catch (reason) { setEditError(message(reason, 'The playlist could not be deleted.')); setBusy(null); setConfirmingDelete(false) }
  }
  const rowActions = (track: Track, index: number) => <>
    <DragHandle index={index} count={tracks.length} label={track.title} disabled={busy !== null} onMove={moveTo}/>
    <button type="button" className="icon-button" disabled={busy !== null || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${track.title} up`} title="Move up"><ArrowUp/></button>
    <button type="button" className="icon-button" disabled={busy !== null || index === tracks.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${track.title} down`} title="Move down"><ArrowDown/></button>
    <button type="button" className="icon-button" disabled={busy !== null} onClick={() => remove(index)} aria-label={`Remove ${track.title} from playlist`} title="Remove from playlist">{busy === `remove-${index}` ? <LoaderCircle className="spin"/> : <X/>}</button>
  </>

  return <div className="page detail-page"><header className="detail-hero playlist-hero"><div className="playlist-cover"><ListMusic/></div><div><span className="eyebrow">{owned ? 'Playlist' : `Shared by ${playlist.owner}${collaborator ? ' · you can edit' : ''}`}</span><h1>{name}</h1><p>{tracks.length} songs · {formatHours(duration)}</p><div className="hero-actions"><button className="button primary" disabled={!tracks.length} onClick={() => usePlayer.getState().playTracks(tracks)}><Play fill="currentColor"/>Play</button><button className="button secondary" disabled={!tracks.length} onClick={() => usePlayer.getState().playTracks([...tracks].sort(() => Math.random() - .5))}><Shuffle/>Shuffle</button><PlayNextButton tracks={tracks} label={name}/><CollectionDownloadButton kind="playlist" item={{ id: playlist.id, name, owner: playlist.owner, coverArt: playlist.coverArt }} tracks={tracks}/>{tracks.length > 0 && <ShareLinkButton ids={[playlist.id]} label={name}/>}<ExportPlaylistButton name={name} tracks={tracks}/>{owned && shares && <SharePlaylist accounts={shares.accounts} sharedWith={sharedWithFor(shares, 'navidrome', playlist.id)} editors={editorsFor(shares, playlist.id)} allowEditing={shares.collaboration !== false} save={(users, editors) => saveNavidromePlaylistShares(api, playlist.id, users, editors)}/>}{canEdit && <button className="button secondary" aria-pressed={editing} onClick={() => { setEditing((value) => !value); setDraftName(name); setEditError(null); setConfirmingDelete(false) }}>{editing ? <><Check/>Done</> : <><Pencil/>Edit</>}</button>}</div></div></header>
    {collaborator && editing && <div className="playlist-edit-bar"><p>Drag the grip (or use the arrows) to reorder, and × to remove a track. Add songs with the + button anywhere in Tomify. Changes save as you make them.</p></div>}
    {collaborator && editing && editError && <p className="login-error" role="alert">{editError}</p>}
    {owned && editing && <>
      <form className="playlist-name-form" onSubmit={(event) => void rename(event)}><input value={draftName} onChange={(event) => setDraftName(event.target.value)} aria-label="Playlist name" maxLength={200}/><button type="submit" className="button secondary" disabled={busy !== null || !draftName.trim() || draftName.trim() === name}>{busy === 'rename' && <LoaderCircle className="spin"/>}Rename</button></form>
      <div className="playlist-edit-bar"><p>Drag the grip (or use the arrows) to reorder, and × to remove a track. Changes save as you make them.</p><button type="button" className="button danger" disabled={busy !== null} onClick={() => setConfirmingDelete(true)}><Trash2/>Delete playlist</button></div>
      {confirmingDelete && <div className="delete-confirm"><AlertTriangle/><div><strong>Delete “{name}”?</strong><p>The playlist is removed from Navidrome{sharedWithFor(shares, 'navidrome', playlist.id).length ? ' and from everyone it is shared with' : ''}. The music itself is not touched.</p><div><button className="button secondary" disabled={busy === 'delete'} onClick={() => setConfirmingDelete(false)}>Keep it</button><button className="button danger" disabled={busy === 'delete'} onClick={() => void deletePlaylist()}>{busy === 'delete' && <LoaderCircle className="spin"/>}Delete playlist</button></div></div></div>}
      {editError && <p className="login-error" role="alert">{editError}</p>}
    </>}
    {!tracks.length && <p className="variant-loading">{canEdit ? 'This playlist is empty. Add tracks from any album, search result or favourite with the + button.' : 'This playlist is empty.'}</p>}
    <TrackList tracks={tracks} addToPlaylist={!editing} selectable={!editing} trackActions={canEdit && editing ? rowActions : undefined}/></div>
}
