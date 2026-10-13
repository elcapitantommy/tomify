import { AlertTriangle, Check, CircleHelp, ListMusic, Music2, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { catalogueApi } from '../lib/catalogue-api'
import { formatHours } from '../lib/format'

export function Playlists() {
  const api = useApi()
  const navidrome = useLoad((signal) => api.playlists(signal), [api])
  const imported = useLoad(() => catalogueApi.list().then((result) => result.playlists), [])
  const empty = navidrome.data && imported.data && !navidrome.data.length && !imported.data.length
  return <div className="page"><header className="page-header playlist-page-header"><div><span className="eyebrow">Your library</span><h1>Playlists</h1><p>Every mix, in its original order.</p></div><div className="page-header-actions"><button className="button secondary" disabled title="Playlist editing is coming later"><Plus/>New playlist</button><Link className="button primary" to="/playlists/import/spotify"><Music2/>Import from Spotify</Link></div></header>
    {(navidrome.loading || imported.loading) && <div className="playlist-list">{[1,2,3,4].map((index) => <div className="playlist-row skeleton" key={index}/>)}</div>}
    {navidrome.error && <ErrorState message={navidrome.error} retry={navidrome.retry}/>} {imported.error && <ErrorState message={imported.error} retry={imported.retry}/>} {empty && <EmptyState title="No playlists yet" message="Import a Spotify playlist or create one in Navidrome."/>}
    {imported.data?.length ? <section><div className="section-title"><h2>Imported playlists</h2></div><div className="playlist-list">{imported.data.map((playlist) => <Link className="playlist-row imported-playlist-row" to={`/playlists/imported/${playlist.id}`} key={playlist.id}><span className="playlist-icon">{playlist.artworkUrl ? <img src={playlist.artworkUrl} alt="" referrerPolicy="no-referrer"/> : <Music2/>}</span><span><strong>{playlist.name}</strong><small>{playlist.counts.total} entries · {playlist.counts.available} ready</small></span><span className="playlist-import-counts">{playlist.counts.available > 0 && <i className="available"><Check/>{playlist.counts.available}</i>}{playlist.counts.missing > 0 && <i className="missing"><AlertTriangle/>{playlist.counts.missing}</i>}{playlist.counts.review > 0 && <i className="review"><CircleHelp/>{playlist.counts.review}</i>}</span></Link>)}</div></section> : null}
    {navidrome.data?.length ? <section><div className="section-title"><h2>Navidrome playlists</h2></div><div className="playlist-list">{navidrome.data.map((playlist) => <Link className="playlist-row" to={`/playlists/${playlist.id}`} key={playlist.id}><span className="playlist-icon"><ListMusic/></span><span><strong>{playlist.name}</strong><small>{playlist.songCount ?? 0} songs · {formatHours(playlist.duration)}</small></span></Link>)}</div></section> : null}
  </div>
}
