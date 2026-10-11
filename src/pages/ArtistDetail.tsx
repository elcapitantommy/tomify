import { Play, Shuffle } from 'lucide-react'
import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { AlbumCard } from '../components/MediaCards'
import { ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { releaseBucket, releaseYearLabel, resolvedReleaseType, sortReleases } from '../lib/release-metadata'
import { usePlayer } from '../stores/player'
import { useReleaseMetadata } from '../stores/releaseMetadata'

export function ArtistDetail() {
  const { id = '' } = useParams()
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const { data, loading, error, retry } = useLoad((signal) => api.artist(id, signal), [api, id])
  const albums = useMemo(() => data?.artist.album ?? [], [data])
  const sections = useMemo(() => {
    const groups = {
      album: albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'album'),
      'single-ep': albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'single-ep'),
      compilation: albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'compilation'),
    }
    return [
      { key: 'album', title: 'Albums', items: sortReleases(groups.album, overrides, 'newest') },
      { key: 'single-ep', title: 'Singles & EPs', items: sortReleases(groups['single-ep'], overrides, 'newest') },
      { key: 'compilation', title: 'Compilations', items: sortReleases(groups.compilation, overrides, 'newest') },
    ]
  }, [albums, overrides])
  const getTracks = async () => (await Promise.all(albums.map((album) => api.album(album.id)))).flatMap((album) => album.song ?? [])
  const playAll = async (shuffle = false) => { const tracks = await getTracks(); usePlayer.getState().playTracks(shuffle ? tracks.sort(() => Math.random() - .5) : tracks) }

  if (loading) return <div className="page"><SkeletonGrid rows={8}/></div>
  if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>
  if (!data) return null

  return <div className="page detail-page">
    <header className="detail-hero artist-hero"><Artwork id={data.artist.coverArt ?? data.artist.id} alt={data.artist.name} round size={1000}/><div><span className="eyebrow">Artist</span><h1>{data.artist.name}</h1><p>{albums.length} releases in your library</p><div className="hero-actions"><button className="button primary" onClick={() => void playAll()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => void playAll(true)}><Shuffle/>Shuffle</button></div></div></header>
    {sections.filter((section) => section.items.length > 0).map((section) => <section key={section.key} className="discography-section"><div className="section-title"><div><span className="eyebrow">{section.items.length} {section.items.length === 1 ? 'release' : 'releases'}</span><h2>{section.title}</h2></div></div><div className="card-grid">{section.items.map((album) => <AlbumCard album={album} key={album.id} dateLabel={releaseYearLabel(album, overrides[album.id])}/>)}</div></section>)}
  </div>
}
