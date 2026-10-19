import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, LifeBuoy, ListChecks, LoaderCircle, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { assessAlbumCompleteness, distinctLocalTrackCount, editionLabel, type RecoveryLink } from '../lib/album-completeness'
import { completenessApi, type TracklistRequest, type TracklistResponse } from '../lib/completeness-api'
import { formatDuration } from '../lib/format'
import { recoveryStatusLabels, type RecoveryStatus } from '../lib/recovery'
import type { Album, Track } from '../types'
import { useAuth } from '../stores/auth'

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: TracklistResponse } | { status: 'unavailable'; message: string } | { status: 'error'; message: string }

// Shown to administrators only. Nothing is fetched from MusicBrainz until the check is asked for.
export function AlbumCompleteness({ album, tracks }: { album: Album; tracks: Track[] }) {
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [request, setRequest] = useState<{ releaseId?: string; force?: boolean; nonce: number }>({ nonce: 0 })
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const isAdmin = useAuth((s) => s.isAdmin) === true

  // A different album starts unchecked again.
  useEffect(() => { setState({ status: 'idle' }); setRequest({ nonce: 0 }); setNotice(null) }, [album.id])

  useEffect(() => {
    if (!request.nonce) return
    const controller = new AbortController()
    const input: TracklistRequest = { albumId: album.id, name: album.name, artist: album.artist, year: album.year, musicBrainzId: album.musicBrainzId, localTrackCount: distinctLocalTrackCount(tracks), releaseId: request.releaseId, force: request.force }
    setState((current) => current.status === 'ready' ? current : { status: 'loading' })
    completenessApi.tracklist(input, controller.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: Error & { code?: string }) => {
        if (error.name === 'AbortError') return
        setState(error.code === 'tracklist-unavailable' ? { status: 'unavailable', message: error.message } : { status: 'error', message: error.message })
      })
    return () => controller.abort()
  }, [album.id, request]) // eslint-disable-line react-hooks/exhaustive-deps

  const data = state.status === 'ready' ? state.data : null
  const result = useMemo(() => data ? assessAlbumCompleteness(data.tracklist, tracks) : null, [data, tracks])

  if (!isAdmin) return null
  if (state.status === 'idle') return <div className="album-completeness-start"><button className="button secondary" onClick={() => setRequest((current) => ({ ...current, nonce: current.nonce + 1 }))}><ListChecks/>Check completeness</button><small>Compare this album with its MusicBrainz tracklist.</small></div>
  if (state.status === 'loading') return <p className="variant-loading album-completeness-loading"><LoaderCircle className="spin"/>Checking the MusicBrainz tracklist…</p>
  if (state.status === 'unavailable') return <p className="variant-loading">Album completeness unavailable: {state.message}</p>
  if (state.status === 'error') return <p className="variant-loading">Album completeness could not be checked: {state.message} <button className="link-button" onClick={() => setRequest((current) => ({ ...current, nonce: current.nonce + 1 }))}>Try again</button></p>
  if (!data || !result) return null

  const { tracklist, editions, recovery } = data
  const multiDisc = tracklist.discCount > 1
  const notQueued = result.missing.filter((track) => !recovery[track.key])
  const addMissing = async (release: boolean) => {
    setAdding(true)
    setNotice(null)
    try {
      const response = await completenessApi.addMissing(tracklist.albumId, notQueued.map((track) => track.key), release)
      setState({ status: 'ready', data: { ...data, recovery: response.recovery } })
      setNotice(release ? 'Added to Recovery as one album search.' : `${response.created} ${response.created === 1 ? 'track' : 'tracks'} added to Recovery${response.existing ? ` · ${response.existing} already queued` : ''}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add the missing tracks to Recovery.')
    } finally {
      setAdding(false)
    }
  }

  return <section className={result.complete ? 'album-completeness complete' : 'album-completeness'} aria-label="Album completeness">
    <div className="album-completeness-heading">
      {result.complete ? <CircleCheck/> : <CircleAlert/>}
      <div>
        <strong>{result.editionMismatch ? 'Edition does not match' : result.complete ? 'Complete' : 'Incomplete'} · {result.present} of {result.total} tracks</strong>
        <small>Compared with MusicBrainz: {tracklist.title}{editionLabel(tracklist) ? ` · ${editionLabel(tracklist)}` : ''}{tracklist.source === 'tagged' ? ' · from your file tags' : tracklist.source === 'manual' ? ' · chosen edition' : ''}</small>
      </div>
      <button className="button secondary" onClick={() => setRequest((current) => ({ releaseId: tracklist.source === 'manual' ? tracklist.releaseId : undefined, force: true, nonce: current.nonce + 1 }))} aria-label="Refresh MusicBrainz tracklist"><RefreshCw/></button>
    </div>

    {editions.length > 1 && <label className="album-completeness-edition"><span>Edition</span><select value={tracklist.releaseId} onChange={(event) => setRequest((current) => ({ releaseId: event.target.value, nonce: current.nonce + 1 }))}>
      {!editions.some((edition) => edition.id === tracklist.releaseId) && <option value={tracklist.releaseId}>{editionLabel({ ...tracklist, trackCount: tracklist.tracks.length }) || tracklist.title}</option>}
      {editions.map((edition) => <option key={edition.id} value={edition.id}>{editionLabel(edition) || edition.title}</option>)}
    </select></label>}

    {result.missing.length > 0 && <>
      <ol className="album-completeness-missing">
        {result.missing.map((track) => <li key={track.key}>
          <span className="album-completeness-position">{multiDisc ? `${track.disc}-${track.number}` : track.number}</span>
          <span className="album-completeness-title"><strong>{track.title}</strong>{track.artist && tracklist.artist && track.artist !== tracklist.artist && <small>{track.artist}</small>}</span>
          <span className="album-completeness-length">{track.length ? formatDuration(track.length) : ''}</span>
          <RecoveryChip link={recovery[track.key]}/>
        </li>)}
      </ol>
      <div className="album-completeness-actions">
        {notQueued.length > 1 && <button className="button primary" disabled={adding} onClick={() => void addMissing(true)}>{adding ? <LoaderCircle className="spin"/> : <LifeBuoy/>}Recover {notQueued.length} missing as one album</button>}
        {notQueued.length > 1 ? <button className="button secondary" disabled={adding} onClick={() => void addMissing(false)}>Add each track separately</button>
          : <button className="button primary" disabled={adding || notQueued.length === 0} onClick={() => void addMissing(false)}>{adding ? <LoaderCircle className="spin"/> : <LifeBuoy/>}{notQueued.length ? 'Add 1 missing to Recovery' : 'All missing tracks are in Recovery'}</button>}
        {notice && <span role="status">{notice}</span>}
      </div>
    </>}

    {result.duplicated > 0 && <p className="album-completeness-note">{result.duplicated} {result.duplicated === 1 ? 'track has' : 'tracks have'} more than one copy in your library.</p>}
    {result.editionMismatch && <p className="album-completeness-note">Most of your tracks are not on this MusicBrainz edition, so it is probably a different release with the same title. {editions.length > 1 ? 'Choose another edition above or refresh.' : 'Refresh to search MusicBrainz again.'}</p>}
    {result.extras.length > 0 && <p className="album-completeness-note">{result.extras.length} local {result.extras.length === 1 ? 'track is' : 'tracks are'} not on this edition: {result.extras.slice(0, 5).map((track) => track.title).join(', ')}{result.extras.length > 5 ? '…' : ''}</p>}
  </section>
}

function RecoveryChip({ link }: { link?: RecoveryLink }) {
  if (!link) return <span className="recovery-status">Missing</span>
  const label = recoveryStatusLabels[link.status as RecoveryStatus] ?? link.status
  return <Link className={`recovery-status ${link.status}`} to={`/recovery?item=${encodeURIComponent(link.id)}`}>In Recovery · {label}</Link>
}
