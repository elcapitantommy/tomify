import { Heart } from 'lucide-react'
import { AlbumCard, ArtistCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'

export function Favourites() { const api = useApi(); const { data, loading, error, retry } = useLoad((signal) => api.starred(signal), [api]); const empty = data && !data.artists.length && !data.albums.length && !data.tracks.length; return <div className="page"><header className="page-header"><span className="eyebrow"><Heart size={14} fill="currentColor"/> Just for you</span><h1>Favourites</h1><p>The music you always come back to.</p></header>{loading && <SkeletonGrid/>}{error && <ErrorState message={error} retry={retry}/>}{empty && <EmptyState title="No favourites yet" message="Star music in Navidrome and it will appear here."/>}{data?.artists.length ? <section><div className="section-title"><h2>Artists</h2></div><div className="card-grid compact">{data.artists.map((artist) => <ArtistCard artist={artist} key={artist.id}/>)}</div></section> : null}{data?.albums.length ? <section><div className="section-title"><h2>Albums</h2></div><div className="card-grid compact">{data.albums.map((album) => <AlbumCard album={album} key={album.id}/>)}</div></section> : null}{data?.tracks.length ? <section><div className="section-title"><h2>Tracks</h2></div><TrackList tracks={data.tracks}/></section> : null}</div> }
