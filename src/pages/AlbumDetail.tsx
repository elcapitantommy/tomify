import { useEffect, useState } from 'react'
import { Check, Pencil, Play, Shuffle, X } from 'lucide-react'
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
  const enrichRelease = useReleaseMetadata((state) => state.enrich)
  const cloudStatus = useReleaseMetadata((state) => state.cloudStatus)
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [refreshingMetadata, setRefreshingMetadata] = useState(false)
  const { data: album, loading, error, retry } = useLoad((signal) => api.album(id, signal), [api, id])
  const tracks = album?.song ?? []
  const override = overrides[id]
  const releaseType = album ? resolvedReleaseType(album, override) : 'album'
  const releaseDate = album ? releaseDateLabel(album, override) : undefined
  const play = (shuffle = false) => usePlayer.getState().playTracks(shuffle ? [...tracks].sort(() => Math.random() - .5) : tracks)

  useEffect(() => {
    if (album && cloudStatus === 'cloud' && !overrides[album.id]) void enrichRelease(album)
  }, [album, cloudStatus, enrichRelease, overrides])

  const saveType = async (nextType: ReleaseType) => {
    if (!album) return
    setSavingMetadata(true)
    const ok = await saveRelease(album.id, { releaseType: nextType })
    setSavingMetadata(false)
    if (ok) setEditingMetadata(false)
  }

  const refreshMetadata = async () => {
    if (!album || override?.source === 'manual') return
    setRefreshingMetadata(true)
    await enrichRelease(album, true)
    setRefreshingMetadata(false)
  }

  const saveDate = async (nextDate: string) => {
    if (!album) return
    setSavingMetadata(true)
    await saveRelease(album.id, { releaseType, releaseDate: nextDate || null })
    setSavingMetadata(false)
  }

  if (loading) return <div className="page"><SkeletonGrid rows={6}/></div>
  if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>
  if (!album) return null

  return <div className="page detail-page">
    <header className="detail-hero"><Artwork id={album.coverArt ?? album.id} alt={album.name} size={1000}/><div><span className="eyebrow">{releaseTypeLabels[releaseType]}</span><h1>{album.name}</h1><p className="detail-artist">{album.artist}</p><p>{releaseDate && `${releaseDate} · `}{tracks.length} songs · {formatHours(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p>{override?.source === 'musicbrainz' && <p className="metadata-source">MusicBrainz classified · {override.musicBrainzId ?? 'matched release'}</p>}<div className="hero-actions"><button className="button primary" onClick={() => play()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => play(true)}><Shuffle/>Shuffle</button>{cloudStatus === 'cloud' && <button className="button secondary" onClick={() => setEditingMetadata((value) => !value)}>{editingMetadata ? <X/> : <Pencil/>}{editingMetadata ? 'Close metadata' : 'Edit metadata'}</button>}</div></div></header>

    {editingMetadata && cloudStatus === 'cloud' && <section className="release-editor cloud-only" aria-label="Release metadata">
      <div className="release-editor-title"><Check/><div><strong>Release metadata</strong><small>{override?.source === 'musicbrainz' ? 'Automatically matched from MusicBrainz and saved to Tomify.' : 'Saved to Tomify and shared across devices.'}</small></div></div>
      <label><span>Release type</span><select disabled={savingMetadata} value={releaseType} onChange={(event) => void saveType(event.target.value as ReleaseType)}><option value="album">Album</option><option value="single">Single</option><option value="ep">EP</option><option value="compilation">Compilation</option><option value="other">Other</option></select></label>
      <label><span>Release date</span><input disabled={savingMetadata} type="date" value={releaseDateInputValue(album, override)} onChange={(event) => void saveDate(event.target.value)}/></label>
    <div className="release-editor-actions">{override?.source !== 'manual' && <button className="button secondary" disabled={refreshingMetadata || savingMetadata} onClick={() => void refreshMetadata()}>{refreshingMetadata ? 'Checking MusicBrainz…' : 'Refresh from MusicBrainz'}</button>}</div>
    </section>}

    <TrackList tracks={tracks} discAware/>
  </div>
}
