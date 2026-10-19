import { useEffect, useState } from 'react'
import { Album, CircleAlert, CircleCheck, CloudDownload, Database, HardDrive, ListMusic, LoaderCircle, Music2, Play, RotateCw, ShieldCheck, Trash2 } from 'lucide-react'
import { artKey, readFile, TRACK_OWNER, type OfflineCollection, type OfflineTrack } from '../lib/offline-db'
import { formatBytes } from '../lib/format'
import { summariseDownloads, useDownloads, type DownloadSummary } from '../stores/downloads'
import { usePlayer } from '../stores/player'

interface StorageFigures { usage?: number; quota?: number }

function useStorageEstimate(version: unknown) {
  const [figures, setFigures] = useState<StorageFigures | null>(null)
  useEffect(() => {
    let active = true
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) { setFigures(null); return }
    navigator.storage.estimate().then((value) => { if (active) setFigures({ usage: value.usage, quota: value.quota }) }, () => { if (active) setFigures(null) })
    return () => { active = false }
  }, [version])
  return figures
}

// Covers come from the device, so the page still has its pictures with no connection.
function OfflineArtwork({ coverArt, icon: Icon }: { coverArt?: string; icon: typeof Album }) {
  const account = useDownloads((state) => state.account)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!account || !coverArt) return
    let active = true
    let created: string | null = null
    readFile(account, artKey(coverArt)).then((blob) => { if (active && blob) { created = URL.createObjectURL(blob); setUrl(created) } }, () => undefined)
    return () => { active = false; if (created) URL.revokeObjectURL(created); setUrl(null) }
  }, [account, coverArt])
  return <span className="artwork download-artwork">{url ? <img src={url} alt=""/> : <span className="artwork-fallback"><Icon/></span>}</span>
}

function statusLabel(summary: DownloadSummary, progress?: number) {
  switch (summary.status) {
    case 'available-offline': return 'Available offline'
    case 'downloading': return summary.total > 1 ? `Downloading ${summary.done} of ${summary.total}` : `Downloading${progress !== undefined ? ` ${Math.round(progress * 100)}%` : ''}`
    case 'queued': return summary.total > 1 ? `Queued · ${summary.done} of ${summary.total} done` : 'Queued'
    case 'failed': return summary.total > 1 ? `${summary.failed} of ${summary.total} failed` : 'Failed'
    default: return 'Not downloaded'
  }
}

function StatusBadge({ summary, progress }: { summary: DownloadSummary; progress?: number }) {
  const Icon = summary.status === 'available-offline' ? CircleCheck : summary.status === 'failed' ? CircleAlert : LoaderCircle
  return <span className={`download-status ${summary.status}`} title={summary.error}><Icon className={summary.status === 'downloading' || summary.status === 'queued' ? 'spin' : undefined}/>{statusLabel(summary, progress)}</span>
}

const playable = (ids: string[], tracks: Record<string, OfflineTrack>) => ids.map((id) => tracks[id]).filter((record): record is OfflineTrack => record?.status === 'available-offline').map((record) => record.track)

function CollectionRow({ collection, tracks }: { collection: OfflineCollection; tracks: Record<string, OfflineTrack> }) {
  const { retry, removeCollection } = useDownloads.getState()
  const summary = summariseDownloads(collection.trackIds, tracks)
  const ready = playable(collection.trackIds, tracks)
  return <li className="download-row">
    <OfflineArtwork coverArt={collection.coverArt} icon={collection.kind === 'album' ? Album : ListMusic}/>
    <span className="download-copy"><strong>{collection.name}</strong><small>{collection.kind === 'album' ? 'Album' : 'Playlist'}{collection.artist ? ` · ${collection.artist}` : ''} · {collection.trackIds.length} songs · {formatBytes(summary.bytes)}</small>{summary.error && <small className="download-error">{summary.error}</small>}</span>
    <StatusBadge summary={summary}/>
    <span className="download-actions">
      <button type="button" className="icon-button" disabled={!ready.length} onClick={() => usePlayer.getState().playTracks(ready)} aria-label={`Play ${collection.name}`} title="Play"><Play/></button>
      {summary.failed > 0 && <button type="button" className="icon-button" onClick={() => void retry(collection.trackIds)} aria-label={`Retry ${collection.name}`} title="Retry"><RotateCw/></button>}
      <button type="button" className="icon-button" onClick={() => void removeCollection(collection.key)} aria-label={`Remove ${collection.name} from downloads`} title="Remove"><Trash2/></button>
    </span>
  </li>
}

function TrackRow({ record, progress, queue }: { record: OfflineTrack; progress?: number; queue: OfflineTrack[] }) {
  const { retry, removeTrack } = useDownloads.getState()
  const summary = summariseDownloads([record.id], { [record.id]: record })
  const ready = queue.filter((item) => item.status === 'available-offline')
  return <li className="download-row">
    <OfflineArtwork coverArt={record.track.coverArt} icon={Music2}/>
    <span className="download-copy"><strong>{record.track.title}</strong><small>{record.track.artist} · {record.track.album}{record.bytes ? ` · ${formatBytes(record.bytes)}` : ''}</small>{record.error && <small className="download-error">{record.error}</small>}</span>
    <StatusBadge summary={summary} progress={progress}/>
    <span className="download-actions">
      <button type="button" className="icon-button" disabled={record.status !== 'available-offline'} onClick={() => usePlayer.getState().playTracks(ready.map((item) => item.track), ready.indexOf(record))} aria-label={`Play ${record.track.title}`} title="Play"><Play/></button>
      {record.status === 'failed' && <button type="button" className="icon-button" onClick={() => void retry([record.id])} aria-label={`Retry ${record.track.title}`} title="Retry"><RotateCw/></button>}
      <button type="button" className="icon-button" onClick={() => void removeTrack(record.id)} aria-label={`Remove ${record.track.title} from downloads`} title="Remove"><Trash2/></button>
    </span>
  </li>
}

export function Downloads() {
  const supported = useDownloads((state) => state.supported)
  const ready = useDownloads((state) => state.ready)
  const tracks = useDownloads((state) => state.tracks)
  const collections = useDownloads((state) => state.collections)
  const progress = useDownloads((state) => state.progress)
  const persisted = useDownloads((state) => state.persisted)
  const notice = useDownloads((state) => state.notice)
  const records = Object.values(tracks)
  const stored = records.reduce((sum, record) => sum + (record.status === 'available-offline' ? record.bytes ?? 0 : 0), 0)
  const storage = useStorageEstimate(stored)
  const albumsAndPlaylists = Object.values(collections).sort((a, b) => b.addedAt - a.addedAt)
  const singles = records.filter((record) => record.owners.includes(TRACK_OWNER)).sort((a, b) => b.addedAt - a.addedAt)
  const failed = records.filter((record) => record.status === 'failed').map((record) => record.id)
  const free = storage?.quota !== undefined && storage.usage !== undefined ? Math.max(0, storage.quota - storage.usage) : undefined

  return <div className="page">
    <header className="page-header"><span className="eyebrow">Offline</span><h1>Downloads</h1><p>Music saved on this device plays with no connection, and Tomify plays the saved copy whenever it has one.</p></header>
    {!supported && <div className="notice"><CloudDownload/><div><strong>This browser can’t keep music offline</strong><p>Downloads need IndexedDB storage, which this browser has turned off (private browsing often does).</p></div></div>}
    {notice && <div className="notice download-notice" role="alert"><CircleAlert/><div><strong>Downloads stopped</strong><p>{notice}</p></div>{failed.length > 0 && <button type="button" className="button secondary" onClick={() => void useDownloads.getState().retry(failed)}><RotateCw/>Retry all</button>}</div>}
    {supported && <div className="download-stats">
      <article><HardDrive/><span><small>Music stored</small><strong>{formatBytes(stored)}</strong></span></article>
      <article><Database/><span><small>Space left for Tomify</small><strong>{free !== undefined ? `${formatBytes(free)} of ${formatBytes(storage?.quota)}` : 'Not reported by this browser'}</strong></span></article>
      <article><ShieldCheck/><span><small>Storage</small><strong>{persisted ? 'Kept until you remove it' : 'The browser may clear it when space runs low'}</strong></span></article>
    </div>}
    {supported && !ready && <p className="download-empty"><LoaderCircle className="spin"/>Loading downloads…</p>}
    {ready && !albumsAndPlaylists.length && !singles.length && <div className="state-card"><CloudDownload/><h2>Nothing downloaded yet</h2><p>Tap Download on an album or playlist, or the download button on a song, to keep it on this device.</p></div>}
    {albumsAndPlaylists.length > 0 && <section><div className="section-title"><h2>Albums and playlists</h2></div><ul className="download-list">{albumsAndPlaylists.map((collection) => <CollectionRow key={collection.key} collection={collection} tracks={tracks}/>)}</ul></section>}
    {singles.length > 0 && <section><div className="section-title"><h2>Songs</h2></div><ul className="download-list">{singles.map((record) => <TrackRow key={record.id} record={record} progress={progress[record.id]} queue={singles}/>)}</ul></section>}
  </div>
}
