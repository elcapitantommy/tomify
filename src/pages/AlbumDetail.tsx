import { useEffect, useMemo, useState } from 'react'
import { Check, ImageUp, Pencil, Play, Shuffle, X } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { AlbumArtworkPicker } from '../components/AlbumArtworkPicker'
import { AlbumCompleteness } from '../components/AlbumCompleteness'
import { AddToPlaylist } from '../components/AddToPlaylist'
import { CollectionDownloadButton } from '../components/DownloadButton'
import { ItemArtists } from '../components/ArtistLinks'
import { Artwork } from '../components/Artwork'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { RatingStars } from '../components/RatingStars'
import { useLoad } from '../hooks/useLoad'
import { useSearchParamState } from '../hooks/useSearchParamState'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { versionLabels } from '../lib/release-versions'
import { collapseReleaseVariants, releaseDateInputValue, releaseDateLabel, releaseFamilyTitle, releaseTypeLabels, resolvedReleaseType, type ReleaseType } from '../lib/release-metadata'
import { usePlayer } from '../stores/player'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { useAuth } from '../stores/auth'

// Titles longer than this (e.g. "Permanent Vacation [924 162-2]") get a smaller size so they stay on about two lines.
const longAlbumTitle = 24

export function AlbumDetail() {
  const { id = '' } = useParams()
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const saveRelease = useReleaseMetadata((state) => state.save)
  const enrichRelease = useReleaseMetadata((state) => state.enrich)
  const cloudStatus = useReleaseMetadata((state) => state.cloudStatus)
  const artworkStatus = useAlbumArtwork((state) => state.status)
  // Editing metadata, changing artwork and the completeness check are administrator tools; the Worker enforces the same.
  const isAdmin = useAuth((state) => state.isAdmin) === true
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [changingArtwork, setChangingArtwork] = useState(false)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [refreshingMetadata, setRefreshingMetadata] = useState(false)

  const { data: album, loading, error, retry } = useLoad(
    (signal) => api.album(id, signal),
    [api, id],
    `album:${api.session.username}:${id}`,
  )
  const override = overrides[id]
  const releaseType = album ? resolvedReleaseType(album, override) : 'album'
  const releaseDate = album ? releaseDateLabel(album, override) : undefined

  useEffect(() => {
    if (album && cloudStatus === 'cloud' && !overrides[album.id]) void enrichRelease(album)
  }, [album, cloudStatus, enrichRelease, overrides])

  const { data: versions, loading: versionsFetching } = useLoad(async (signal) => {
    if (!album) return []
    const metadataSnapshot = useReleaseMetadata.getState().overrides
    const summaries = album.artistId
      ? (await api.artist(album.artistId, signal)).artist.album ?? []
      : await api.allAlbums(signal)
    const group = collapseReleaseVariants(summaries, metadataSnapshot).find((item) => item.variants.some((variant) => variant.id === album.id))
    const otherVariants = (group?.variants ?? []).filter((variant) => variant.id !== album.id)
    if (!otherVariants.length) return [album]
    const others = await Promise.all(otherVariants.map((variant) => api.album(variant.id, signal)))
    return [album, ...others]
  }, [api, album?.id, album?.artistId])

  // Versions always start with the album they were looked up for. Until they match this album, the lookup is still pending:
  // the render before the lookup restarts otherwise shows the completeness check briefly, then hides it again.
  const versionsLoading = versionsFetching || (album !== null && versions?.[0]?.id !== album.id)
  const fullVersions = useMemo(() => !versionsLoading && versions?.length ? versions : album ? [album] : [], [album, versions, versionsLoading])

  const groupTitle = album ? releaseFamilyTitle(album) : ''
  // With several versions, one is shown at a time and picked from a dropdown; the choice lives in the URL (?version=).
  const versionIds = useMemo(() => fullVersions.map((version) => version.id), [fullVersions])
  const [selectedVersionId, setSelectedVersionId] = useSearchParamState('version', album?.id ?? id, versionIds)
  const selectedVersion = fullVersions.find((version) => version.id === selectedVersionId) ?? fullVersions[0] ?? album
  const labels = useMemo(() => versionLabels(fullVersions), [fullVersions])
  const versionTracks = selectedVersion?.song ?? []
  const playVersion = (shuffle = false) => usePlayer.getState().playTracks(shuffle ? [...versionTracks].sort(() => Math.random() - .5) : versionTracks)

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
    <header className="detail-hero album-hero">{(() => {
      const shown = selectedVersion ?? album
      const art = <Artwork id={shown.coverArt ?? shown.id} albumId={shown.id} alt={groupTitle} size={1000}/>
      return isAdmin && artworkStatus === 'ready' ? <button type="button" className="artwork-change" onClick={() => setChangingArtwork((value) => !value)} aria-expanded={changingArtwork} aria-label={changingArtwork ? 'Close album artwork options' : 'Change album artwork'}>{art}<span className="artwork-change-hint" aria-hidden="true"><ImageUp/>Change artwork</span></button> : art
    })()}<div><span className="eyebrow">{releaseTypeLabels[releaseType]}</span><h1 className={groupTitle.length > longAlbumTitle ? 'long-title' : undefined}>{groupTitle}</h1><p className="detail-artist"><ItemArtists item={album}/></p><p>{releaseDate && `${releaseDate} · `}{fullVersions.length > 1 ? `${fullVersions.length} versions · ` : ''}{versionTracks.length} songs · {formatHours(versionTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}</p>{selectedVersion && <RatingStars key={`rating:${selectedVersion.id}`} item={selectedVersion} name={selectedVersion.name || groupTitle} className="album-rating"/>}{override?.source === 'musicbrainz' && <p className="metadata-source">MusicBrainz classified · {override.musicBrainzId ?? 'matched release'}</p>}
      {!versionsLoading && fullVersions.length > 1 && <label className="release-sort version-picker"><span>Version</span><select value={selectedVersion?.id} onChange={(event) => setSelectedVersionId(event.target.value)}>{fullVersions.map((version) => <option key={version.id} value={version.id}>{labels.get(version.id) ?? version.name}</option>)}</select></label>}
      <div className="hero-actions"><button className="button primary" onClick={() => playVersion()}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => playVersion(true)}><Shuffle/>Shuffle</button>{versionTracks.length > 0 && <AddToPlaylist songIds={versionTracks.map((track) => track.id)} label={selectedVersion?.name ?? groupTitle} variant="button"/>}{!versionsLoading && selectedVersion && <CollectionDownloadButton key={selectedVersion.id} kind="album" item={{ id: selectedVersion.id, name: selectedVersion.name || groupTitle, artist: selectedVersion.artist || album.artist, coverArt: selectedVersion.coverArt ?? selectedVersion.id }} tracks={versionTracks}/>}{isAdmin && cloudStatus === 'cloud' && <button className="button secondary" onClick={() => setEditingMetadata((value) => !value)}>{editingMetadata ? <X/> : <Pencil/>}{editingMetadata ? 'Close metadata' : 'Edit metadata'}</button>}</div></div></header>

    {isAdmin && editingMetadata && cloudStatus === 'cloud' && <section className="release-editor cloud-only" aria-label="Release metadata">
      <div className="release-editor-title"><Check/><div><strong>Release metadata</strong><small>{override?.source === 'musicbrainz' ? 'Automatically matched from MusicBrainz and saved to Tomify.' : override?.source === 'manual' ? 'Manual override saved to Tomify.' : 'No cloud classification yet.'}</small></div></div>
      <label><span>Release type</span><select disabled={savingMetadata} value={releaseType} onChange={(event) => void saveType(event.target.value as ReleaseType)}><option value="album">Album</option><option value="single">Single</option><option value="ep">EP</option><option value="compilation">Compilation</option><option value="other">Other</option></select></label>
      <label><span>Release date</span><input disabled={savingMetadata} type="date" value={releaseDateInputValue(album, override)} onChange={(event) => void saveDate(event.target.value)}/></label>
      <div className="release-editor-actions"><button className="button secondary" disabled={refreshingMetadata || savingMetadata} onClick={() => void refreshMetadata()}>{refreshingMetadata ? 'Checking MusicBrainz…' : override?.source === 'manual' ? 'Replace with MusicBrainz' : 'Refresh from MusicBrainz'}</button></div>
    </section>}
    {isAdmin && changingArtwork && artworkStatus === 'ready' && <AlbumArtworkPicker album={selectedVersion ?? album} searchOnOpen onClose={() => setChangingArtwork(false)}/>}

    {isAdmin && !versionsLoading && cloudStatus === 'cloud' && <AlbumCompleteness key={`completeness:${selectedVersion?.id}`} album={selectedVersion ?? album} tracks={versionTracks}/>}

    {versionsLoading && album && <><TrackList tracks={album.song ?? []} discAware/><p className="variant-loading">Checking for other editions…</p></>}
    {!versionsLoading && <TrackList key={`tracks:${selectedVersion?.id}`} tracks={versionTracks} discAware/>}
  </div>
}
