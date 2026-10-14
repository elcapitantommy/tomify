import { ListMusic, Play, Shuffle } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { usePlayer } from '../stores/player'

export function PlaylistDetail() { const api = useApi(); const { id = '' } = useParams(); const { data, loading, error, retry } = useLoad((signal) => api.playlist(id, signal), [api, id]); const tracks = data?.entry ?? []; if (loading) return <div className="page"><SkeletonGrid/></div>; if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>; if (!data) return null; return <div className="page detail-page"><header className="detail-hero playlist-hero"><div className="playlist-cover"><ListMusic/></div><div><span className="eyebrow">Playlist</span><h1>{data.name}</h1><p>{tracks.length} songs · {formatHours(data.duration)}</p><div className="hero-actions"><button className="button primary" onClick={() => usePlayer.getState().playTracks(tracks)}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => usePlayer.getState().playTracks([...tracks].sort(() => Math.random() - .5))}><Shuffle/>Shuffle</button></div></div></header><TrackList tracks={tracks}/></div> }
