import { useEffect, useMemo, useState } from 'react'
import { Check, Pencil, Play, Shuffle, X } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { collapseReleaseVariants, releaseDateInputValue, releaseDateLabel, releaseFamilyTitle, releaseTypeLabels, resolvedReleaseType, type ReleaseType } from '../lib/release-metadata'
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
  const override = overrides[id]
  const releaseType = album ? resolvedReleaseType(album, override) : 'album'
  const releaseDate = album ? releaseDateLabel(album, override) : undefined

  useEffect(() => {
    if (album && cloudStatus === 'cloud' && !overrides[album.id]) void enrichRelease(album)
  }, [album, cloudStatus, enrichRelease, overrides])

  const { data: versions, loading: versionsLoading } = useLoad(async (signal) => {
    if (!album) return []
    const summaries = album.artistId
      ? (await api.artist(album.artistId, signal)).artist.album ?? []
      : await api.albums('alphabeticalByName', 500, signal)
    const group = collapseReleaseVariants(summaries, overrides).find((item) => item.variants.some((variant) => variant.id === album.id))
    const variantSummaries = group?.variants ?? [album]
    return Promise.all(variantSummaries.map((variant) => api.album(variant.id, signal)))
  }, [api, album?.id, album?.artistId, overrides])

  const fullVersions = useMemo(() => {
    if (versions?.length) return versions
    return album ? [album] : []
  }, [album, versions])

  const groupTitle = album ? releaseFamilyTitle(album) : ''
  const allTracks = fullVersions.flatMap((version) => version.song ?? [])
  const playAllVersions = (shuffle = false) => usePlayer.getState().playTracks(shuffle ? [...allTracks].sort(() => Math.random() - .5) : allTracks)

  const saveType = async (nextType: ReleaseType) => {
    if (!album) return
    setSavingMetadata(true)
    const ok = await saveRelease(album.id, { releaseType: nextType })
    setSavingMetadata(false)
    if (ok) setEditingMetadata(false)
  }

  const refreshMetadata = async () => {
    if (!album) return
    setRefreshingMetadata(true)
    await enrichRelease(album, true, true)
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
    <header className="detail-hero"><Artwork id={album.coverArt ?? album.id} alt={groupTitle} size={1000}/><div><span className="eyebrow">{releaseTypeLabels[releaseType]}</span><h1>{groupTitle}</h1><p className="detail-artist">{album.artist}</p><p>{releaseDate && `${releaseDate} · `}{fullVersions.length > 1 ? `${fullVersions.length} versions · ` : ''}{allTracks.length} songs · {formatHours(allTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p>{override?.source === 'musicbrainz' && <p className="metadata-source">MusicBrainz classified · {override.musicBrainzId ?? 'matched release'}</p>}<div className="hero-actions"><button className="button primary" onClick={() => playAllVersions()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => playAllVersions(true)}><Shuffle/>Shuffle</button>{cloudStatus === 'cloud' && <button className="button secondary" onClick={() => setEditingMetadata((value) => !value)}>{editingMetadata ? <X/> : <Pencil/>}{editingMetadata ? 'Close metadata' : 'Edit metadata'}</button>}</div></div></header>

    {editingMetadata && cloudStatus === 'cloud' && <section className="release-editor cloud-only" aria-label="Release metadata">
      <div className="release-editor-title"><Check/><div><strong>Release metadata</strong><small>{override?.source === 'musicbrainz' ? 'Automatically matched from MusicBrainz and saved to Tomify.' : override?.source === 'manual' ? 'Manual override saved to Tomify.' : 'No cloud classification yet.'}</small></div></div>
      <label><span>Release type</span><select disabled={savingMetadata} value={releaseType} onChange={(event) => void saveType(event.target.value as ReleaseType)}><option value="album">Album</option><option value="single">Single</option><option value="ep">EP</option><option value="compilation">Compilation</option><option value="other">Other</option></select></label>
      <label><span>Release date</span><input disabled={savingMetadata} type="date" value={releaseDateInputValue(album, override)} onChange={(event) => void saveDate(event.target.value)}/></label>
      <div className="release-editor-actions"><button className="button secondary" disabled={refreshingMetadata || savingMetadata} onClick={() => void refreshMetadata()}>{refreshingMetadata ? 'Checking MusicBrainz…' : override?.source === 'manual' ? 'Replace with MusicBrainz' : 'Refresh from MusicBrainz'}</button></div>
    </section>}

    {versionsLoading && <SkeletonGrid rows={4}/>}
    {!versionsLoading && fullVersions.length === 1 && <TrackList tracks={fullVersions[0].song ?? []} discAware/>}
    {!versionsLoading && fullVersions.length > 1 && <div className="release-variants">{fullVersions.map((version, index) => {
      const tracks = version.song ?? []
      return <section className="release-variant" key={version.id}>
        <div className="release-variant-heading"><div><span className="eyebrow">Version {index + 1}</span><h2>{version.name}</h2><p>{version.year ? `${version.year} · ` : ''}{tracks.length} songs · {formatHours(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p></div><div className="release-variant-actions"><button className="button secondary" onClick={() => usePlayer.getState().playTracks(tracks)}><Play fill="currentColor"/>Play this version</button></div></div>
        <TrackList tracks={tracks} discAware/>
      </section>
    })}</div>}
  </div>
}
