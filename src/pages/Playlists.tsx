import { useState } from 'react'
import { AlertTriangle, Check, CircleHelp, FileUp, ListMusic, LoaderCircle, Music2, Plus, Sparkles } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState, ErrorState } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { catalogueApi } from '../lib/catalogue-api'
import { describeRules, smartPlaylistsApi } from '../lib/smart-playlists'
import { formatHours } from '../lib/format'
import { sharedWithFor } from '../lib/playlist-shares'
import { loadPlaylistShares } from '../lib/playlist-sharing'

export function Playlists() {
  const api = useApi()
  const navidrome = useLoad((signal) => api.playlists(signal), [api])
  const imported = useLoad(() => catalogueApi.list().then((result) => result.playlists), [])
  const shares = useLoad(() => loadPlaylistShares(), [])
  const smart = useLoad(() => smartPlaylistsApi.list(), [])
  const sharedWithMe = shares.data?.sharedWithMe ?? []
  const sharedNote = (kind: 'navidrome' | 'imported', id: string) => { const users = sharedWithFor(shares.data, kind, id); return users.length ? ` · Shared with ${users.join(', ')}` : '' }
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true); setCreateError(null)
    try { const playlist = await api.createPlaylist(name.trim()); navigate(`/playlists/${playlist.id}`) }
    catch (reason) { setCreateError(reason instanceof Error ? reason.message : 'The playlist could not be created.'); setSaving(false) }
  }
  const empty = navidrome.data && imported.data && !navidrome.data.length && !imported.data.length && !sharedWithMe.length && !smart.data?.length
  return <div className="page"><header className="page-header playlist-page-header"><div><span className="eyebrow">Your library</span><h1>Playlists</h1><p>Every mix, in its original order.</p></div><div className="page-header-actions"><button className="button secondary" aria-expanded={creating} onClick={() => { setCreating((value) => !value); setCreateError(null) }}><Plus/>New playlist</button><Link className="button secondary" to="/playlists/smart/new"><Sparkles/>New smart playlist</Link><Link className="button secondary" to="/playlists/import/file"><FileUp/>Import file</Link><Link className="button primary" to="/playlists/import/spotify"><Music2/>Import from Spotify</Link></div></header>
    {creating && <form className="playlist-name-form" onSubmit={(event) => void create(event)}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" aria-label="New playlist name" maxLength={200}/><button type="button" className="button secondary" onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="button primary" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin"/> : <Plus/>}Create</button>{createError && <p role="alert" className="playlist-form-error">{createError}</p>}</form>}
    {(navidrome.loading || imported.loading) && <div className="playlist-list">{[1,2,3,4].map((index) => <div className="playlist-row skeleton" key={index}/>)}</div>}
    {navidrome.error && <ErrorState message={navidrome.error} retry={navidrome.retry}/>} {imported.error && <ErrorState message={imported.error} retry={imported.retry}/>} {empty && <EmptyState title="No playlists yet" message="Create a playlist here, or import one from Spotify."/>}
    {smart.data?.length ? <section><div className="section-title"><h2>Smart playlists</h2></div><div className="playlist-list">{smart.data.map((playlist) => <Link className="playlist-row" to={`/playlists/smart/${playlist.id}`} key={playlist.id}><span className="playlist-icon"><Sparkles/></span><span><strong>{playlist.name}</strong><small>{describeRules(playlist.rules)}</small></span></Link>)}</div></section> : null}
    {imported.data?.length ? <section><div className="section-title"><h2>Imported playlists</h2></div><div className="playlist-list">{imported.data.map((playlist) => <Link className="playlist-row imported-playlist-row" to={`/playlists/imported/${playlist.id}`} key={playlist.id}><span className="playlist-icon">{playlist.artworkUrl ? <img src={playlist.artworkUrl} alt="" referrerPolicy="no-referrer"/> : <Music2/>}</span><span><strong>{playlist.name}</strong><small>{playlist.counts.total} entries · {playlist.counts.available} ready{sharedNote('imported', playlist.id)}</small></span><span className="playlist-import-counts">{playlist.counts.available > 0 && <i className="available"><Check/>{playlist.counts.available}</i>}{playlist.counts.missing > 0 && <i className="missing"><AlertTriangle/>{playlist.counts.missing}</i>}{playlist.counts.review > 0 && <i className="review"><CircleHelp/>{playlist.counts.review}</i>}</span></Link>)}</div></section> : null}
    {sharedWithMe.length ? <section><div className="section-title"><h2>Shared with you</h2></div><div className="playlist-list">{sharedWithMe.map((playlist) => <Link className="playlist-row" to={playlist.kind === 'imported' ? `/playlists/imported/${playlist.playlistId}` : `/playlists/${playlist.playlistId}`} key={`${playlist.kind}:${playlist.playlistId}`}><span className="playlist-icon">{playlist.kind === 'imported' ? <Music2/> : <ListMusic/>}</span><span><strong>{playlist.name}</strong><small>Shared by {playlist.owner}{playlist.canEdit ? ' · you can edit' : ''}</small></span></Link>)}</div></section> : null}
    {navidrome.data?.length ? <section><div className="section-title"><h2>Navidrome playlists</h2></div><div className="playlist-list">{navidrome.data.map((playlist) => <Link className="playlist-row" to={`/playlists/${playlist.id}`} key={playlist.id}><span className="playlist-icon"><ListMusic/></span><span><strong>{playlist.name}</strong><small>{playlist.songCount ?? 0} songs · {formatHours(playlist.duration)}{sharedNote('navidrome', playlist.id)}</small></span></Link>)}</div></section> : null}
  </div>
}
