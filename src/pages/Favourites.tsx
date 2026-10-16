import { useEffect, useRef } from 'react'
import { Heart } from 'lucide-react'
import { AlbumCard, ArtistCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { useFavourites } from '../stores/favourites'

export function Favourites() {
  const api = useApi(); const { data: loaded, loading, error, retry, refresh } = useLoad((signal) => api.starred(signal), [api])
  // Unstarred items leave at once; a confirmed star or unstar anywhere refetches so newly starred music appears.
  const overrides = useFavourites((s) => s.overrides); const version = useFavourites((s) => s.version); const seenVersion = useRef(version)
  useEffect(() => { if (version !== seenVersion.current) { seenVersion.current = version; refresh() } }, [version, refresh])
  const kept = <T extends { id: string }>(items: T[]) => items.filter((item) => overrides[item.id] !== false)
  const data = loaded && { artists: kept(loaded.artists), albums: kept(loaded.albums), tracks: kept(loaded.tracks) }
  const empty = data && !data.artists.length && !data.albums.length && !data.tracks.length; return <div className="page"><header className="page-header"><span className="eyebrow"><Heart size={14} fill="currentColor"/> Just for you</span><h1>Favourites</h1><p>The music you always come back to.</p></header>{loading && <SkeletonGrid/>}{error && <ErrorState message={error} retry={retry}/>}{empty && <EmptyState title="No favourites yet" message="Tap the heart on a track or album and it will appear here."/>}{data?.artists.length ? <section><div className="section-title"><h2>Artists</h2></div><div className="card-grid compact">{data.artists.map((artist) => <ArtistCard artist={artist} key={artist.id}/>)}</div></section> : null}{data?.albums.length ? <section><div className="section-title"><h2>Albums</h2></div><div className="card-grid compact">{data.albums.map((album) => <AlbumCard album={album} key={album.id}/>)}</div></section> : null}{data?.tracks.length ? <section><div className="section-title"><h2>Tracks</h2></div><TrackList tracks={data.tracks}/></section> : null}</div> }
