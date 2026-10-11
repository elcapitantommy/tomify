import { Play, Shuffle, Tag } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { releaseDateInputValue, releaseDateLabel, releaseTypeLabels, resolvedReleaseType, type ReleaseType } from '../lib/release-metadata'
import { usePlayer } from '../stores/player'
import { useReleaseMetadata } from '../stores/releaseMetadata'

export function AlbumDetail() {
  const { id = '' } = useParams()
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const saveRelease = useReleaseMetadata((state) => state.save)
  const cloudStatus = useReleaseMetadata((state) => state.cloudStatus)
  const { data: album, loading, error, retry } = useLoad((signal) => api.album(id, signal), [api, id])
  const tracks = album?.song ?? []
  const override = overrides[id]
  const releaseType = album ? resolvedReleaseType(album, override) : 'album'
  const releaseDate = album ? releaseDateLabel(album, override) : undefined
  const play = (shuffle = false) => usePlayer.getState().playTracks(shuffle ? [...tracks].sort(() => Math.random() - .5) : tracks)

  if (loading) return <div className="page"><SkeletonGrid rows={6}/></div>
  if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>
  if (!album) return null

  return <div className="page detail-page">
    <header className="detail-hero"><Artwork id={album.coverArt ?? album.id} alt={album.name} size={1000}/><div><span className="eyebrow">{releaseTypeLabels[releaseType]}</span><h1>{album.name}</h1><p className="detail-artist">{album.artist}</p><p>{releaseDate && `${releaseDate} · `}{tracks.length} songs · {formatHours(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p><div className="hero-actions"><button className="button primary" onClick={() => play()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => play(true)}><Shuffle/>Shuffle</button></div></div></header>
    <section className="release-editor" aria-label="Release metadata"><div className="release-editor-title"><Tag/><div><strong>Tomify release metadata</strong><small>{cloudStatus === 'cloud' ? 'Synced across Tomify' : cloudStatus === 'checking' ? 'Checking cloud metadata…' : 'Saved on this browser until cloud metadata is connected'}</small></div></div><label><span>Release type</span><select value={releaseType} onChange={(event) => void saveRelease(album.id, { releaseType: event.target.value as ReleaseType })}><option value="album">Album</option><option value="single">Single</option><option value="ep">EP</option><option value="compilation">Compilation</option><option value="other">Other</option></select></label><label><span>Release date</span><input type="date" value={releaseDateInputValue(album, override)} onChange={(event) => void saveRelease(album.id, { releaseDate: event.target.value || null })}/></label></section>
    <TrackList tracks={tracks} discAware/>
  </div>
}
