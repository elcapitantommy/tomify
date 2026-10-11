import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { AlbumCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { usePlayer } from '../stores/player'

export function Albums() { const api = useApi(); const { data, error, loading, retry } = useLoad((signal) => api.albums('alphabeticalByName', 500, signal), [api]); const play = async (id: string) => usePlayer.getState().playTracks((await api.album(id)).song ?? []); return <div className="page"><header className="page-header"><span className="eyebrow">The collection</span><h1>Albums</h1><p>{data ? `${data.length} records, ready when you are` : 'Browse every record on your shelves.'}</p></header>{loading && <SkeletonGrid rows={10}/>} {error && <ErrorState message={error} retry={retry}/>} {data && !data.length && <EmptyState title="No albums yet" message="Add music to Navidrome and it will appear here."/>}<div className="card-grid">{data?.map((album) => <AlbumCard album={album} key={album.id} onPlay={() => void play(album.id)}/>)}</div></div> }
