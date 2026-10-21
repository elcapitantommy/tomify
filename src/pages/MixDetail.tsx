import { useState } from 'react'
import { ListPlus, Play, Shuffle } from 'lucide-react'
import { ExportPlaylistButton } from '../components/ExportPlaylist'
import { useParams } from 'react-router-dom'
import { MixCover } from '../components/MixCard'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { cachedMixes, mixesApi } from '../lib/mixes-api'
import { usePlayer } from '../stores/player'

export function MixDetail() {
  const api = useApi(); const { id = '' } = useParams()
  const [saved, setSaved] = useState<string | null>(null)
  const { data, loading, error, retry } = useLoad(async (signal) => (cachedMixes() ?? await mixesApi.load(signal)).mixes.find((mix) => mix.id === id) ?? null, [id])
  if (loading) return <div className="page"><SkeletonGrid/></div>
  if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>
  if (!data) return <div className="page"><EmptyState title="Mix not found" message="Your mixes have been refreshed since this link was made. Head back to Home for today's mixes."/></div>
  const tracks = data.tracks
  const duration = tracks.reduce((total, track) => total + (track.duration ?? 0), 0)
  const save = async () => {
    setSaved('Saving…')
    try { await api.createPlaylist(data.title, tracks.map((track) => track.id)); setSaved('Saved to your playlists') } catch (reason) { setSaved(reason instanceof Error ? reason.message : 'Could not save the playlist.') }
  }
  return <div className="page detail-page"><header className="detail-hero"><MixCover mix={data} size={400}/><div><span className="eyebrow">Made for you</span><h1>{data.title}</h1><p>{data.description}</p><p>{tracks.length} songs · {formatHours(duration)}</p><div className="hero-actions"><button className="button primary" onClick={() => usePlayer.getState().playTracks(tracks)}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => usePlayer.getState().playTracks([...tracks].sort(() => Math.random() - 0.5))}><Shuffle/>Shuffle</button><button className="button secondary" onClick={() => void save()} disabled={saved === 'Saving…' || saved === 'Saved to your playlists'}><ListPlus/>Save as playlist</button><ExportPlaylistButton name={data.title} tracks={tracks}/></div>{saved && <p role="status">{saved}</p>}</div></header><TrackList tracks={tracks}/></div>
}
