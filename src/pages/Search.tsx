import { Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AlbumCard, ArtistCard } from '../components/MediaCards'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../lib/api-context'
import type { SearchResults } from '../types'
import { BrowseTiles } from './Browse'

export function Search() { const api = useApi(); const [query, setQuery] = useState(''); const [results, setResults] = useState<SearchResults | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (!query.trim()) { setResults(null); setLoading(false); return } const controller = new AbortController(); const timer = window.setTimeout(() => { setLoading(true); setError(null); api.search(query.trim(), controller.signal).then(setResults).catch((reason) => { if (reason.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Search failed.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) }) }, 350); return () => { window.clearTimeout(timer); controller.abort() } }, [api, query])
  const empty = results && !results.artists.length && !results.albums.length && !results.tracks.length
  return <div className="page search-page"><header className="page-header"><span className="eyebrow">Find your next listen</span><h1>Search</h1></header><div className="search-box"><SearchIcon/><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Artists, albums or tracks" aria-label="Search your library" title="Search your library"/>{query && <button onClick={() => setQuery('')} aria-label="Clear search" title="Clear search"><X/></button>}</div>{!query && <BrowseTiles/>}{loading && <SkeletonGrid rows={5}/>} {error && <ErrorState message={error}/>} {empty && <div className="search-prompt"><h2>No matches for “{query}”</h2><p>Try a different title, artist or spelling.</p></div>}{results && !loading && <div className="search-results">{results.artists.length > 0 && <section><h2>Artists</h2><div className="card-grid compact">{results.artists.map((artist) => <ArtistCard artist={artist} key={artist.id}/>)}</div></section>}{results.albums.length > 0 && <section><h2>Albums</h2><div className="card-grid compact">{results.albums.map((album) => <AlbumCard album={album} key={album.id}/>)}</div></section>}{results.tracks.length > 0 && <section><h2>Tracks</h2><TrackList tracks={results.tracks}/></section>}</div>}</div>
}
