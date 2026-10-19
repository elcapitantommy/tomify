import { CircleAlert, CircleCheck, Download, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { collectionKey, TRACK_OWNER, type CollectionKind } from '../lib/offline-db'
import { summariseDownloads, useDownloads, type CollectionInput } from '../stores/downloads'
import type { Track } from '../types'

// The download control in a track row. Nothing shows where the browser can't store music offline.
export function TrackDownloadButton({ track }: { track: Track }) {
  const ready = useDownloads((state) => state.ready)
  const record = useDownloads((state) => state.tracks[track.id])
  const progress = useDownloads((state) => state.progress[track.id])
  if (!ready) return null
  const { downloadTracks, retry, removeTrack } = useDownloads.getState()
  if (!record) return <button type="button" className="icon-button download-toggle" onClick={() => void downloadTracks([track])} aria-label={`Download ${track.title}`} title="Download"><Download/></button>
  if (record.status === 'queued' || record.status === 'downloading') return <button type="button" className="icon-button download-toggle busy" disabled aria-label={`Downloading ${track.title}`} title={progress !== undefined ? `Downloading ${Math.round(progress * 100)}%` : record.error ?? 'Waiting to download'}><LoaderCircle className="spin"/></button>
  if (record.status === 'failed') return <button type="button" className="icon-button download-toggle failed" onClick={() => void retry([track.id])} aria-label={`Retry downloading ${track.title}`} title={record.error ?? 'Download failed'}><CircleAlert/></button>
  if (!record.owners.includes(TRACK_OWNER)) return <button type="button" className="icon-button download-toggle done" disabled aria-label={`${track.title} is downloaded`} title="Downloaded with an album or playlist"><CircleCheck/></button>
  return <button type="button" className="icon-button download-toggle done" onClick={() => void removeTrack(track.id)} aria-label={`Remove ${track.title} from downloads`} title="Downloaded · remove"><CircleCheck/></button>
}

// The download button on an album or playlist page.
export function CollectionDownloadButton({ kind, item, tracks }: { kind: CollectionKind; item: CollectionInput; tracks: Track[] }) {
  const ready = useDownloads((state) => state.ready)
  const collection = useDownloads((state) => state.collections[collectionKey(kind, item.id)])
  const records = useDownloads((state) => state.tracks)
  if (!ready || !tracks.length) return null
  const { downloadCollection, retry } = useDownloads.getState()
  const download = () => void downloadCollection(kind, item, tracks)
  if (!collection) return <button type="button" className="button secondary" onClick={download}><Download/>Download</button>
  const summary = summariseDownloads(collection.trackIds, records)
  if (summary.status === 'queued' || summary.status === 'downloading') return <button type="button" className="button secondary" disabled><LoaderCircle className="spin"/>Downloading {summary.done} of {summary.total}</button>
  if (summary.status === 'failed') return <button type="button" className="button secondary" onClick={() => void retry(collection.trackIds)} title={summary.error}><RotateCw/>Retry download</button>
  // A playlist edited (or reordered) since it was downloaded: bring the copy on the device up to date.
  const ids = [...new Set(tracks.map((track) => track.id))]
  if (ids.length !== collection.trackIds.length || ids.some((id, index) => id !== collection.trackIds[index]) || summary.done < summary.total) return <button type="button" className="button secondary" onClick={download}><RefreshCw/>Update download</button>
  return <Link className="button secondary download-done" to="/downloads"><CircleCheck/>Downloaded</Link>
}
