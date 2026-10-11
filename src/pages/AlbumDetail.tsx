import { Play, Shuffle } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { usePlayer } from '../stores/player'

export function AlbumDetail() { const { id = '' } = useParams(); const api = useApi(); const { data: album, loading, error, retry } = useLoad((signal) => api.album(id, signal), [api, id]); const tracks = album?.song ?? []; const play = (shuffle = false) => usePlayer.getState().playTracks(shuffle ? [...tracks].sort(() => Math.random() - .5) : tracks)
  if (loading) return <div className="page"><SkeletonGrid rows={6}/></div>; if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>; if (!album) return null
  return <div className="page detail-page"><header className="detail-hero"><Artwork id={album.coverArt ?? album.id} alt={album.name} size={1000}/><div><span className="eyebrow">Album</span><h1>{album.name}</h1><p className="detail-artist">{album.artist}</p><p>{album.year && `${album.year} · `}{tracks.length} songs · {formatHours(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p><div className="hero-actions"><button className="button primary" onClick={() => play()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => play(true)}><Shuffle/>Shuffle</button></div></div></header><TrackList tracks={tracks} discAware/></div>
}
