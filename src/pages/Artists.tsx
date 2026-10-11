import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { ArtistCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'

export function Artists() { const api = useApi(); const { data, error, loading, retry } = useLoad((signal) => api.artists(signal), [api]); return <div className="page"><header className="page-header"><span className="eyebrow">The collection</span><h1>Artists</h1><p>{data ? `${data.length} artists in your library` : 'Everyone in your library, A–Z.'}</p></header>{loading && <SkeletonGrid rows={10}/>} {error && <ErrorState message={error} retry={retry}/>} {data && !data.length && <EmptyState title="No artists yet" message="Add music to Navidrome and it will appear here."/>}<div className="card-grid artist-grid">{data?.map((artist) => <ArtistCard artist={artist} key={artist.id}/>)}</div></div> }
