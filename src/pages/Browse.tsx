import { Compass, Shuffle } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlbumCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { browseGenres, decadeLabel, decadesOf, parseDecade, tileHue } from '../lib/browse'
import { usePlayer } from '../stores/player'
import type { Album } from '../types'

const GENRES_SHOWN = 24

// Genre and decade tiles. Shown on the Browse page and on Search before anything is typed.
export function BrowseTiles() {
  const api = useApi()
  const [allGenres, setAllGenres] = useState(false)
  const { data, loading, error, retry } = useLoad(async (signal) => {
    const [genres, albums] = await Promise.all([api.genreList(signal), api.allAlbums(signal)])
    return { genres: browseGenres(genres), decades: decadesOf(albums) }
  }, [api], `browse:${api.session.username}`)
  if (loading) return <SkeletonGrid rows={4}/>
  if (error) return <ErrorState message={error} retry={retry}/>
  if (!data) return null
  const genres = allGenres ? data.genres : data.genres.slice(0, GENRES_SHOWN)
  return <div className="browse-tiles">
    {data.decades.length > 0 && <section aria-label="Decades"><div className="section-title"><h2>Decades</h2></div><div className="tile-grid">{data.decades.map((decade) => <Link key={decade.start} className="browse-tile decade" style={{ '--tile-hue': tileHue(String(decade.start)) } as React.CSSProperties} to={`/browse/decade/${decade.start}`}><strong>{decadeLabel(decade.start)}</strong><small>{decade.albumCount} albums</small></Link>)}</div></section>}
    {data.genres.length > 0 && <section aria-label="Genres"><div className="section-title"><h2>Genres</h2>{data.genres.length > GENRES_SHOWN && <button type="button" className="link-button" onClick={() => setAllGenres(!allGenres)}>{allGenres ? 'Show fewer' : `All ${data.genres.length} genres`}</button>}</div><div className="tile-grid">{genres.map((genre) => <Link key={genre.name} className="browse-tile" style={{ '--tile-hue': tileHue(genre.name) } as React.CSSProperties} to={`/browse/genre/${encodeURIComponent(genre.name)}`}><strong>{genre.name}</strong><small>{genre.albumCount} albums</small></Link>)}</div></section>}
  </div>
}

export function Browse() {
  return <div className="page"><header className="page-header"><span className="eyebrow"><Compass size={14}/> Your library</span><h1>Browse</h1><p>Your music by decade and genre.</p></header><BrowseTiles/></div>
}

function AlbumShelf({ title, eyebrow, load, shuffle, cacheKey }: { title: string; eyebrow: string; load: (signal: AbortSignal) => Promise<Album[]>; shuffle: () => Promise<void>; cacheKey: string }) {
  const { data, loading, error, retry } = useLoad(load, [cacheKey], cacheKey)
  const [starting, setStarting] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  const albums = [...(data ?? [])].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name))
  const start = async () => { setStarting(true); setPlayError(null); try { await shuffle() } catch (reason) { setPlayError(reason instanceof Error ? reason.message : 'Could not start playing.') } finally { setStarting(false) } }
  return <div className="page"><header className="page-header"><span className="eyebrow"><Compass size={14}/> {eyebrow}</span><h1>{title}</h1>{data && <p>{albums.length} {albums.length === 1 ? 'album' : 'albums'}</p>}<div className="hero-actions"><button type="button" className="button primary" disabled={starting || !albums.length} onClick={() => void start()}><Shuffle/>{starting ? 'Starting…' : 'Shuffle play'}</button><Link className="button secondary" to="/browse">All genres and decades</Link></div>{playError && <p className="device-error" role="alert">{playError}</p>}</header>
    {loading && <SkeletonGrid/>}{error && <ErrorState message={error} retry={retry}/>}
    {data && !albums.length && <EmptyState title="Nothing here yet" message="No albums in the library match."/>}
    {albums.length > 0 && <div className="card-grid">{albums.map((album) => <AlbumCard album={album} key={album.id}/>)}</div>}
  </div>
}

export function GenreDetail() {
  const api = useApi()
  const { name = '' } = useParams()
  const play = async () => { const songs = await api.randomSongs({ size: 200, genre: name }); if (!songs.length) throw new Error('No songs found in this genre.'); usePlayer.getState().playTracks(songs, 0, { keepOrder: true }) }
  return <AlbumShelf key={name} title={name} eyebrow="Genre" cacheKey={`genre:${api.session.username}:${name}`} load={(signal) => api.albumsByGenre(name, signal)} shuffle={play}/>
}

export function DecadeDetail() {
  const api = useApi()
  const start = parseDecade(useParams().start)
  if (start === null) return <div className="page"><EmptyState title="Not a decade" message="Pick a decade from Browse."/></div>
  const play = async () => { const songs = await api.randomSongs({ size: 200, fromYear: start, toYear: start + 9 }); if (!songs.length) throw new Error('No songs found from this decade.'); usePlayer.getState().playTracks(songs, 0, { keepOrder: true }) }
  return <AlbumShelf key={start} title={decadeLabel(start)} eyebrow="Decade" cacheKey={`decade:${api.session.username}:${start}`} load={(signal) => api.albumsByYears(start, start + 9, signal)} shuffle={play}/>
}
