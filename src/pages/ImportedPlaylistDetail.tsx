import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, CircleHelp, ExternalLink, ListMusic, LoaderCircle, Play, RefreshCw } from 'lucide-react'
import { ExportPlaylistButton } from '../components/ExportPlaylist'
import { Link, useParams } from 'react-router-dom'
import { useApi } from '../lib/api-context'
import { catalogueApi } from '../lib/catalogue-api'
import { revalidateCatalogueItems, type CataloguePlaylist } from '../lib/catalogue-import'
import { SharePlaylist } from '../components/SharePlaylist'
import { sharedWithFor, type PlaylistShares } from '../lib/playlist-shares'
import { loadPlaylistShares, saveImportedPlaylistShares } from '../lib/playlist-sharing'
import { usePlayer } from '../stores/player'
import { useAuth } from '../stores/auth'

export function ImportedPlaylistDetail() {
  const { id = '' } = useParams(); const api = useApi(); const isAdmin = useAuth((s) => s.isAdmin) === true; const [playlist, setPlaylist] = useState<CataloguePlaylist | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [shares, setShares] = useState<PlaylistShares | null>(null)
  useEffect(() => { let cancelled = false; void loadPlaylistShares().then((loaded) => { if (!cancelled) setShares(loaded) }); return () => { cancelled = true } }, [id])
  useEffect(() => { let cancelled = false; void catalogueApi.get(id).then(async ({ playlist: loaded }) => {
    if (cancelled) return; setPlaylist(loaded); setLoading(false)
    // Recipients of a shared playlist can play it but only the owner's session records matches.
    if (loaded.sharedWithMe) return
    const resolved = await revalidateCatalogueItems(loaded.items, api)
    // The daily refresh adds new entries unmatched; once matched here, the ones still missing go to Recovery if the import asked for that.
    const queueMissing = useAuth.getState().isAdmin === true && loaded.provenance?.autoRecovery === true && loaded.items.some((item) => item.status === 'missing' && !item.recoveryId)
    if ((resolved.length || queueMissing) && !cancelled) { const updated = await catalogueApi.resolve(id, resolved, queueMissing); if (!cancelled) setPlaylist(updated.playlist) }
  }).catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'Playlist could not be loaded.'); setLoading(false) } }); return () => { cancelled = true } }, [api, id])
  if (loading) return <div className="page"><div className="state-card"><LoaderCircle className="spin"/><h2>Loading playlist</h2></div></div>
  if (error || !playlist) return <div className="page"><div className="login-error">{error || 'Playlist not found.'}</div></div>
  const playable = playlist.items.flatMap((item) => item.status === 'available' && item.localTrack ? [item.localTrack] : [])
  return <div className="page imported-playlist-page"><header className="detail-hero playlist-hero">{playlist.artworkUrl ? <a href={playlist.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open the original playlist" title="Open the original playlist"><img className="imported-playlist-art" src={playlist.artworkUrl} alt="" referrerPolicy="no-referrer"/></a> : <div className="playlist-cover"><ListMusic/></div>}<div><Link className="eyebrow" to="/playlists"><ArrowLeft size={14}/>{playlist.sharedWithMe ? `Shared by ${playlist.owner}` : 'Imported playlist'}</Link><h1>{playlist.name}</h1><p>{playlist.counts.total} entries · {playlist.counts.available} ready · {playlist.counts.missing + playlist.counts.review} pending</p><div className="hero-actions"><button className="button primary" disabled={!playable.length} onClick={() => usePlayer.getState().playTracks(playable)}><Play fill="currentColor"/>Play available</button>{!playlist.sharedWithMe && <Link className="button secondary" to={`/playlists/import/spotify?url=${encodeURIComponent(playlist.sourceUrl)}`}><RefreshCw/>Refresh from Spotify</Link>}{!playlist.sharedWithMe && shares && <SharePlaylist accounts={shares.accounts} sharedWith={sharedWithFor(shares, 'imported', playlist.id)} save={(users) => saveImportedPlaylistShares(playlist.id, users)}/>}<ExportPlaylistButton name={playlist.name} tracks={playable}/><a className="button secondary" href={playlist.sourceUrl} target="_blank" rel="noreferrer">Spotify <ExternalLink/></a></div></div></header>
    <ol className="import-track-list imported">{playlist.items.map((item) => <li key={item.id}><span className="import-position">{String(item.position + 1).padStart(2, '0')}</span><span className="import-track-copy"><strong>{item.artists.join(', ')} – {item.title}</strong><small>{item.album}</small></span>{item.status === 'available' ? <span className="import-status available"><Check/>Ready</span> : item.recoveryId && isAdmin ? <Link className="import-status missing" to={`/recovery?item=${item.recoveryId}`}><RefreshCw/>Recovering…</Link> : item.status === 'review' ? <span className="import-status review"><CircleHelp/>Review match</span> : <span className="import-status missing"><AlertTriangle/>{item.status === 'unavailable' ? 'Unavailable' : 'Missing'}</span>}</li>)}</ol>
  </div>
}
