import { Play, Shuffle } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { AlbumCard } from '../components/MediaCards'
import { ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { usePlayer } from '../stores/player'

export function ArtistDetail() { const { id = '' } = useParams(); const api = useApi(); const { data, loading, error, retry } = useLoad((signal) => api.artist(id, signal), [api, id]); const albums = data?.artist.album ?? []; const getTracks = async () => (await Promise.all(albums.map((album) => api.album(album.id)))).flatMap((album) => album.song ?? []); const playAll = async (shuffle = false) => { const tracks = await getTracks(); usePlayer.getState().playTracks(shuffle ? tracks.sort(() => Math.random() - .5) : tracks) }
  if (loading) return <div className="page"><SkeletonGrid rows={8}/></div>; if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>; if (!data) return null
  return <div className="page detail-page"><header className="detail-hero artist-hero"><Artwork id={data.artist.coverArt ?? data.artist.id} alt={data.artist.name} round size={1000}/><div><span className="eyebrow">Artist</span><h1>{data.artist.name}</h1><p>{albums.length} albums in your library</p><div className="hero-actions"><button className="button primary" onClick={() => void playAll()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => void playAll(true)}><Shuffle/>Shuffle</button></div></div></header><div className="section-title"><h2>Albums</h2></div><div className="card-grid">{albums.map((album) => <AlbumCard album={album} key={album.id}/>)}</div></div>
}
