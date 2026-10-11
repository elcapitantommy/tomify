import { Play, Shuffle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { AlbumCard } from '../components/MediaCards'
import { ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { releaseBucket, releaseYearLabel, resolvedReleaseType, sortReleases, type ReleaseFilter } from '../lib/release-metadata'
import { usePlayer } from '../stores/player'
import { useReleaseMetadata } from '../stores/releaseMetadata'

const artistFilters: Array<{ value: ReleaseFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'album', label: 'Albums' },
  { value: 'single-ep', label: 'Singles & EPs' },
  { value: 'compilation', label: 'Compilations' },
]

export function ArtistDetail() {
  const { id = '' } = useParams()
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const [filter, setFilter] = useState<ReleaseFilter>('all')
  const { data, loading, error, retry } = useLoad((signal) => api.artist(id, signal), [api, id])
  const albums = useMemo(() => data?.artist.album ?? [], [data])
  const sections = useMemo(() => {
    const groups = {
      album: albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'album'),
      'single-ep': albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'single-ep'),
      compilation: albums.filter((album) => releaseBucket(resolvedReleaseType(album, overrides[album.id])) === 'compilation'),
    }
    return [
      { key: 'album' as const, title: 'Albums', items: sortReleases(groups.album, overrides, 'newest') },
      { key: 'single-ep' as const, title: 'Singles & EPs', items: sortReleases(groups['single-ep'], overrides, 'newest') },
      { key: 'compilation' as const, title: 'Compilations', items: sortReleases(groups.compilation, overrides, 'newest') },
    ]
  }, [albums, overrides])
  const counts = {
    all: albums.length,
    album: sections.find((section) => section.key === 'album')?.items.length ?? 0,
    'single-ep': sections.find((section) => section.key === 'single-ep')?.items.length ?? 0,
    compilation: sections.find((section) => section.key === 'compilation')?.items.length ?? 0,
  }
  const visibleSections = filter === 'all' ? sections : sections.filter((section) => section.key === filter)
  const getTracks = async () => (await Promise.all(albums.map((album) => api.album(album.id)))).flatMap((album) => album.song ?? [])
  const playAll = async (shuffle = false) => { const tracks = await getTracks(); usePlayer.getState().playTracks(shuffle ? tracks.sort(() => Math.random() - .5) : tracks) }

  if (loading) return <div className="page"><SkeletonGrid rows={8}/></div>
  if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>
  if (!data) return null

  return <div className="page detail-page">
    <header className="detail-hero artist-hero"><Artwork id={data.artist.coverArt ?? data.artist.id} alt={data.artist.name} round size={1000}/><div><span className="eyebrow">Artist</span><h1>{data.artist.name}</h1><p>{albums.length} releases in your library</p><div className="hero-actions"><button className="button primary" onClick={() => void playAll()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => void playAll(true)}><Shuffle/>Shuffle</button></div></div></header>
    <div className="release-toolbar artist-release-toolbar"><div className="release-tabs" role="tablist" aria-label="Artist release type">{artistFilters.map((item) => <button key={item.value} className={filter === item.value ? 'release-tab active' : 'release-tab'} onClick={() => setFilter(item.value)}>{item.label}<span>{counts[item.value]}</span></button>)}</div></div>
    {visibleSections.filter((section) => section.items.length > 0).map((section) => <section key={section.key} className="discography-section"><div className="section-title"><div><span className="eyebrow">{section.items.length} {section.items.length === 1 ? 'release' : 'releases'}</span><h2>{section.title}</h2></div></div><div className="card-grid">{section.items.map((album) => <AlbumCard album={album} key={album.id} dateLabel={releaseYearLabel(album, overrides[album.id])}/>)}</div></section>)}
  </div>
}
