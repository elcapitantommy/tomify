import { ListMusic } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'

export function Playlists() { const api = useApi(); const { data, loading, error, retry } = useLoad((signal) => api.playlists(signal), [api]); return <div className="page"><header className="page-header"><span className="eyebrow">Your library</span><h1>Playlists</h1><p>Every mix, in its original order.</p></header>{loading && <div className="playlist-list">{[1,2,3,4].map((i) => <div className="playlist-row skeleton" key={i}/>)}</div>}{error && <ErrorState message={error} retry={retry}/>} {data && !data.length && <EmptyState title="No playlists yet" message="Create one in Navidrome and it will appear here."/>}<div className="playlist-list">{data?.map((playlist) => <Link className="playlist-row" to={`/playlists/${playlist.id}`} key={playlist.id}><span className="playlist-icon"><ListMusic/></span><span><strong>{playlist.name}</strong><small>{playlist.songCount ?? 0} songs · {formatHours(playlist.duration)}</small></span></Link>)}</div></div> }
