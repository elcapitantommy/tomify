import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, LockKeyhole, ChevronDown, ChevronUp, CircleGauge, ExternalLink, FileAudio, Landmark, LoaderCircle, Magnet, Plus, Search, Server, ShieldCheck, Trash2, Youtube } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { recoveryApi } from '../lib/recovery-api'
import { canImportRestOfDownload, qualityLabel, recoveryStatusLabels as statusLabels, type RecoveryBackend, defaultRecoverySearchFields, recoveryFieldValue, recoveryItemHeading, looksLikeTorrentLink, recoveryItemSubtitle, recoverySearchFields, torrentTransferSummary, recoverySearchFieldsReady, isTorrentSearchResult, torrentResultSummary, type RecoveryItem, type RecoveryMetadataChoices, type RecoverySearchField, type RecoveryStatus } from '../lib/recovery'
import { formatDuration } from '../lib/format'
import { useAuth } from '../stores/auth'

type RecoveryBusyAction = 'add' | 'add-link' | 'search-youtube' | 'search-internet-archive' | 'search-usenet' | 'search-torrent' | 'select' | 'acquire' | 'import-remaining' | 'status' | 'delete'
type RecoveryBusyState = { id: string; action: RecoveryBusyAction } | null
const searchBackendLabels: Record<RecoveryBackend, string> = { youtube: 'YouTube', 'internet-archive': 'Internet Archive', usenet: 'NZB', torrent: 'Torrent' }
const sourceLabels: Record<RecoveryBackend, string> = { youtube: 'YouTube', 'internet-archive': 'Internet Archive', usenet: 'Usenet indexer', torrent: 'Torrent link' }

export function Recovery() {
  const isAdmin = useAuth((s) => s.isAdmin)
  // Hidden from the navigation for everyone else; the Worker refuses Recovery requests from non-administrators too.
  if (isAdmin !== true) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Recovery</h1><p>{isAdmin === null ? 'Checking your account…' : 'Recovery is only available to Navidrome administrators.'}</p></header>{isAdmin === false && <section className="settings-card"><div className="setting-row"><LockKeyhole/><span><strong>Ask an administrator</strong><small>They can find and add missing music to the library for you.</small></span></div></section>}</div>
  return <RecoveryQueue/>
}

function RecoveryQueue() {
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [backends, setBackends] = useState<Array<{ id: string; label: string; available: boolean; authentication?: 'configured' | 'not-configured' | 'not-required' | 'unavailable'; reason?: string; search?: boolean }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<RecoveryBusyState>(null)
  const [searchNote, setSearchNote] = useState<{ id: string; text: string; error: boolean } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(searchParams.get('item'))
  const [form, setForm] = useState({ artist: '', title: '', album: '', duration: '', trackNumber: '' })

  const load = useCallback(async () => {
    setError(null)
    try {
      const result = await recoveryApi.list()
      setItems(result.items)
      setBackends(result.backends)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the recovery queue.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const active = items.filter((item) => item.status === 'queued' || item.status === 'downloading')
    if (!active.length) return
    const timer = window.setInterval(() => {
      void Promise.all(active.map((item) => recoveryApi.pollJob(item.id).then(({ item: updated }) => setItems((current) => current.map((value) => value.id === updated.id ? updated : value))).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not refresh a recovery job.'))))
    }, 3000)
    return () => window.clearInterval(timer)
  }, [items])
  const counts = useMemo(() => ({
    missing: items.filter((item) => item.status === 'missing' || item.status === 'candidate-found').length,
    recovered: items.filter((item) => item.status === 'recovered').length,
    upgrade: items.filter((item) => item.status === 'needs-upgrade').length,
  }), [items])
  const youtube = backends.find((backend) => backend.id === 'youtube')
  const internetArchive = backends.find((backend) => backend.id === 'internet-archive')
  const usenet = backends.find((backend) => backend.id === 'usenet')
  const torrent = backends.find((backend) => backend.id === 'torrent')

  const wantedFormReady = Boolean(form.artist.trim() || form.title.trim() || form.album.trim())

  async function addItem(event: React.FormEvent) {
    event.preventDefault()
    if (!wantedFormReady) return
    setBusy({ id: 'new', action: 'add' })
    setError(null)
    try {
      const { item } = await recoveryApi.add({
        artist: form.artist.trim() || undefined, title: form.title.trim() || undefined, album: form.album.trim() || undefined,
        duration: form.duration ? Number(form.duration) : undefined,
        trackNumber: form.trackNumber ? Number(form.trackNumber) : undefined,
      })
      setItems((current) => [item, ...current])
      setForm({ artist: '', title: '', album: '', duration: '', trackNumber: '' })
      setAdding(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the wanted music.') }
    finally { setBusy(null) }
  }

  async function act(id: string, busyAction: RecoveryBusyAction, action: () => Promise<{ item: RecoveryItem }>) {
    setBusy({ id, action: busyAction }); setError(null)
    try {
      const { item } = await action()
      setItems((current) => current.map((value) => value.id === id ? item : value))
      setExpanded(id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery action failed.') }
    finally { setBusy(null) }
  }

  // Search outcomes (including failures) are reported on the row itself, where the button was clicked.
  async function search(id: string, backend: RecoveryBackend, searchFields?: RecoverySearchField[]) {
    setBusy({ id, action: backend === 'youtube' ? 'search-youtube' : backend === 'internet-archive' ? 'search-internet-archive' : backend === 'torrent' ? 'search-torrent' : 'search-usenet' }); setError(null); setSearchNote(null)
    try {
      const { item } = await recoveryApi.search(id, backend, searchFields)
      setItems((current) => current.map((value) => value.id === id ? item : value))
      setExpanded(id)
      const found = item.candidates.filter((candidate) => candidate.backend === backend).length
      setSearchNote({ id, error: false, text: found ? `${searchBackendLabels[backend]} search found ${found} result${found === 1 ? '' : 's'}.` : `${searchBackendLabels[backend]} search found no results${backend === 'torrent' ? ' with seeds' : ''}.` })
    } catch (cause) { setSearchNote({ id, error: true, text: cause instanceof Error ? cause.message : `${searchBackendLabels[backend]} search failed.` }) }
    finally { setBusy(null) }
  }

  // A pasted link becomes the item's torrent candidate and is selected straight away, opening the metadata review.
  async function addTorrentLink(id: string, link: string) {
    setBusy({ id, action: 'add-link' }); setError(null); setSearchNote(null)
    try {
      const { item } = await recoveryApi.addTorrentLink(id, link)
      const candidate = item.candidates.find((value) => value.backend === 'torrent' && !value.importedPath)
      const { item: selected } = candidate ? await recoveryApi.select(id, candidate.id) : { item }
      setItems((current) => current.map((value) => value.id === id ? selected : value))
      setExpanded(id)
      return true
    } catch (cause) { setSearchNote({ id, error: true, text: cause instanceof Error ? cause.message : 'Could not add the torrent link.' }); return false }
    finally { setBusy(null) }
  }

  async function deleteItem(id: string) {
    setBusy({ id, action: 'delete' }); setError(null)
    try {
      await recoveryApi.delete(id)
      setItems((current) => current.filter((value) => value.id !== id))
      setExpanded((current) => current === id ? null : current)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete the recovery item.') }
    finally { setBusy(null) }
  }

  return <div className="page recovery-page">
    <header className="page-header recovery-header"><div><span className="eyebrow">Collection repair</span><h1>Recovery</h1><p>Rebuild missing music from sources you are authorised to use, with every match and quality decision recorded.</p></div><button className="button primary" onClick={() => setAdding((value) => !value)}><Plus/>Add wanted music</button></header>
    <div className="recovery-stats"><article><Search/><span><strong>{counts.missing}</strong><small>Missing or under review</small></span></article><article><Check/><span><strong>{counts.recovered}</strong><small>Recovered</small></span></article><article><CircleGauge/><span><strong>{counts.upgrade}</strong><small>Needs a better copy</small></span></article></div>
    <div className="recovery-safety"><ShieldCheck/><div><strong>Source-aware by design</strong><p>YouTube and Internet Archive are optional candidate sources. Tomify records the source and requires you to confirm that copying it is authorised. Recovery imports are never treated as verified archival masters.</p></div>{youtube?.available && <span className={`youtube-auth ${youtube.authentication ?? 'unavailable'}`}>YouTube authentication: {youtube.authentication === 'configured' ? 'configured' : 'not configured'}</span>}</div>
    {adding && <form className="recovery-form" onSubmit={addItem}><label><span>Artist</span><input value={form.artist} onChange={(event) => setForm({ ...form, artist: event.target.value })}/></label><label><span>Album</span><input value={form.album} onChange={(event) => setForm({ ...form, album: event.target.value })}/></label><label><span>Track</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })}/></label><p className="recovery-form-hint">Fill in any combination of artist, album and track. Leave the track blank to recover a whole album.</p><label><span>Duration (seconds)</span><input min="1" type="number" value={form.duration} onChange={(event) => setForm({ ...form, duration: event.target.value })}/></label><label><span>Track no.</span><input min="1" type="number" value={form.trackNumber} onChange={(event) => setForm({ ...form, trackNumber: event.target.value })}/></label><button className="button primary" disabled={busy !== null || !wantedFormReady}>{busy?.action === 'add' ? <LoaderCircle className="spin"/> : <Plus/>}Add to queue</button></form>}
    {youtube && !youtube.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>YouTube search is not connected.</strong> {youtube.reason ?? 'Configure the optional recovery agent to search and inspect candidates.'}</span></div>}
    {internetArchive && !internetArchive.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>Internet Archive search is not connected.</strong> {internetArchive.reason ?? 'Configure the recovery agent to search and inspect candidates.'}</span></div>}
    {torrent && !torrent.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>Torrent links are not connected.</strong> {torrent.reason ?? 'Configure qBittorrent and its download directory on the recovery agent.'}</span></div>}
    {usenet && !usenet.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>Usenet Recovery is not connected.</strong> {usenet.reason ?? 'Configure SABnzbd or NZBGet and its download directory on the recovery agent.'}</span></div>}
    {error && <div className="login-error recovery-error">{error}</div>}
    {loading ? <div className="state-card"><LoaderCircle className="spin"/><h2>Loading recovery queue</h2></div> : items.length === 0 ? <div className="state-card"><FileAudio/><h2>No missing music queued</h2><p>Add an artist, album or track you want Tomify to help recover.</p></div> : <div className="recovery-list">{items.map((item) => <RecoveryRow key={item.id} item={item} expanded={expanded === item.id} busyAction={busy?.id === item.id ? busy.action : null} youtubeAvailable={youtube?.available === true} archiveAvailable={internetArchive?.available === true} usenetAvailable={usenet?.available === true} torrentAvailable={torrent?.available === true} torrentSearchAvailable={torrent?.available === true && torrent.search === true} onAddTorrentLink={(link) => addTorrentLink(item.id, link)} onToggle={() => setExpanded(expanded === item.id ? null : item.id)} searchNote={searchNote?.id === item.id ? searchNote : null} onSearch={(backend, searchFields) => void search(item.id, backend, searchFields)} onSelect={(candidateId) => void act(item.id, 'select', () => recoveryApi.select(item.id, candidateId))} onAcquire={(candidateId, rightsBasis, metadataChoices, artworkCandidateId) => void act(item.id, 'acquire', () => recoveryApi.acquire(item.id, candidateId, rightsBasis, metadataChoices, artworkCandidateId))} onImportRemaining={() => void act(item.id, 'import-remaining', () => recoveryApi.importRemaining(item.id))} onStatus={(status) => void act(item.id, 'status', () => recoveryApi.updateStatus(item.id, status))} onDelete={() => void deleteItem(item.id)}/>)}</div>}
  </div>
}

function RecoveryRow({ item, expanded, busyAction, searchNote, youtubeAvailable, archiveAvailable, usenetAvailable, torrentAvailable, torrentSearchAvailable, onAddTorrentLink, onToggle, onSearch, onSelect, onAcquire, onImportRemaining, onStatus, onDelete }: { item: RecoveryItem; expanded: boolean; busyAction: RecoveryBusyAction | null; searchNote: { text: string; error: boolean } | null; youtubeAvailable: boolean; archiveAvailable: boolean; usenetAvailable: boolean; torrentAvailable: boolean; torrentSearchAvailable: boolean; onAddTorrentLink(link: string): Promise<boolean>; onToggle(): void; onSearch(backend: RecoveryBackend, searchFields?: RecoverySearchField[]): void; onSelect(id: string): void; onAcquire(id: string, rights: string, metadataChoices: RecoveryMetadataChoices, artworkCandidateId: string | null): void; onImportRemaining(): void; onStatus(status: RecoveryStatus): void; onDelete(): void }) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [rights, setRights] = useState('')
  const [metadataChoices, setMetadataChoices] = useState<RecoveryMetadataChoices>({ artist: false, title: false, album: false, releaseDate: false, trackNumbers: false })
  const [artworkCandidateId, setArtworkCandidateId] = useState<string | null>(null)
  const [torrentLink, setTorrentLink] = useState('')
  const [usenetSearchFields, setUsenetSearchFields] = useState<RecoverySearchField[]>(() => defaultRecoverySearchFields(item))
  const usenetSearchReady = recoverySearchFieldsReady(item, usenetSearchFields)
  const toggleUsenetField = (field: RecoverySearchField) => setUsenetSearchFields((current) => current.includes(field) ? current.filter((value) => value !== field) : recoverySearchFields.filter((value) => value === field || current.includes(value)))
  const selected = item.candidates.find((candidate) => candidate.selected)
  const searching = busyAction === 'search-youtube' ? 'YouTube' : busyAction === 'search-internet-archive' ? 'Internet Archive' : busyAction === 'search-usenet' ? 'NZB indexers' : busyAction === 'search-torrent' ? 'torrents with seeds' : busyAction === 'add-link' ? 'the torrent link' : null
  const busy = busyAction !== null || item.status === 'queued' || item.status === 'downloading'
  // A running torrent can still be deleted: the agent stops it and removes its data from qBittorrent.
  const torrentRunning = (item.status === 'queued' || item.status === 'downloading') && selected?.backend === 'torrent'
  const deleteBlocked = busyAction !== null || ((item.status === 'queued' || item.status === 'downloading') && !torrentRunning)
  const hasImportedAudio = item.candidates.some((candidate) => Boolean(candidate.importedPath))
  const importedCount = Number(selected?.provenance?.importedCount || 0)
  const resolution = item.metadataResolution?.candidateId === selected?.id ? item.metadataResolution : null
  const matched = resolution?.metadata
  useEffect(() => {
    const enabled = resolution?.strong === true
    setMetadataChoices({ artist: enabled && Boolean(matched?.artist), title: enabled && Boolean(matched?.title), album: enabled && Boolean(matched?.album), releaseDate: enabled && Boolean(matched?.releaseDate), trackNumbers: enabled && Boolean(matched?.trackNumber || matched?.discNumber) })
  }, [resolution?.resolvedAt, resolution?.strong, matched?.artist, matched?.title, matched?.album, matched?.releaseDate, matched?.trackNumber, matched?.discNumber])
  useEffect(() => { setArtworkCandidateId(item.artworkResolution?.selectedCandidateId || null) }, [item.artworkResolution?.resolvedAt, item.artworkResolution?.selectedCandidateId])
  // Metadata review and rights confirmation open directly under the selected candidate.
  const importReview = <>{selected && !selected.importedPath && resolution && <MetadataReview item={item} choices={metadataChoices} onChange={setMetadataChoices} artworkCandidateId={artworkCandidateId} onArtworkChange={setArtworkCandidateId} busy={busy} onContinue={() => setConfirming(selected.id)}/>}{confirming && <div className="rights-confirm"><ShieldCheck/><div><strong>Confirm this source can be copied</strong><p>Owning the physical release does not automatically authorise downloading an unrelated upload. State why this specific source is authorised.</p><select value={rights} onChange={(event) => setRights(event.target.value)}><option value="">Choose a basis…</option><option value="uploader-authorised">Uploader/rights holder permits downloads</option><option value="creative-commons">Creative Commons licence permits this use</option><option value="public-domain">Public domain</option><option value="other-authorisation">Other explicit authorisation</option></select><div><button className="button secondary" onClick={() => { setConfirming(null); setRights('') }}>Cancel</button><button className="button primary" disabled={!rights || busy} onClick={() => { onAcquire(confirming, rights, metadataChoices, artworkCandidateId); setConfirming(null); setRights('') }}>Confirm and import</button></div></div></div>}</>
  return <article className="recovery-row">
    <button className="recovery-summary" onClick={onToggle}><span className={`recovery-status ${item.status}`}>{statusLabels[item.status]}</span><span className="recovery-title"><strong>{recoveryItemHeading(item)}</strong><small>{recoveryItemSubtitle(item)}</small></span><span className="recovery-source">{selected ? <>{selected.backend === 'internet-archive' ? <Landmark/> : selected.backend === 'usenet' ? <Server/> : selected.backend === 'torrent' ? <Magnet/> : <Youtube/>}{selected.channel}</> : 'No source selected'}</span><span className="recovery-quality">{selected?.provenance?.job && !selected.importedPath ? `${selected.provenance.job.progress}% · ${selected.provenance.job.status}` : importedCount > 1 ? `Imported ${importedCount} tracks` : selected ? qualityLabel(selected) : item.duration ? formatDuration(item.duration) : '—'}</span>{expanded ? <ChevronUp/> : <ChevronDown/>}</button>
    {expanded && <div className="recovery-detail"><div className="recovery-actions"><button className={busyAction === 'search-youtube' ? 'button secondary busy' : 'button secondary'} disabled={busy || !youtubeAvailable} onClick={() => onSearch('youtube')}>{busyAction === 'search-youtube' ? <LoaderCircle className="spin"/> : <Youtube/>}Search YouTube</button><button className={busyAction === 'search-internet-archive' ? 'button secondary busy' : 'button secondary'} disabled={busy || !archiveAvailable} onClick={() => onSearch('internet-archive')}>{busyAction === 'search-internet-archive' ? <LoaderCircle className="spin"/> : <Landmark/>}Search Internet Archive</button><span className="usenet-search-control"><span className="usenet-search-fields" role="group" aria-label="NZB and torrent search fields">{recoverySearchFields.map((field) => <label key={field} className={usenetSearchFields.includes(field) ? 'active' : undefined} title={recoveryFieldValue(item, field) ? undefined : `No ${field === 'track' ? 'track title' : field} entered`}><input type="checkbox" checked={usenetSearchFields.includes(field)} disabled={busy || !recoveryFieldValue(item, field)} onChange={() => toggleUsenetField(field)}/>{field === 'artist' ? 'Artist' : field === 'album' ? 'Album' : 'Track'}</label>)}</span><button className={busyAction === 'search-usenet' ? 'button secondary busy' : 'button secondary'} disabled={busy || !usenetAvailable || !usenetSearchReady} onClick={() => onSearch('usenet', usenetSearchFields)}>{busyAction === 'search-usenet' ? <LoaderCircle className="spin"/> : <Server/>}Search NZB</button><button className={busyAction === 'search-torrent' ? 'button secondary busy' : 'button secondary'} disabled={busy || !torrentSearchAvailable || !usenetSearchReady} title={torrentAvailable && !torrentSearchAvailable ? 'Update the recovery agent to search torrents' : 'Only torrents with seeds are shown'} onClick={() => onSearch('torrent', usenetSearchFields)}>{busyAction === 'search-torrent' ? <LoaderCircle className="spin"/> : <Magnet/>}Search torrents</button></span><form className="torrent-link-control" onSubmit={(event) => { event.preventDefault(); void onAddTorrentLink(torrentLink.trim()).then((added) => { if (added) setTorrentLink('') }) }}><input aria-label="Torrent link" placeholder="Paste a magnet or .torrent link" value={torrentLink} disabled={busy || !torrentAvailable} onChange={(event) => setTorrentLink(event.target.value)}/><button className={busyAction === 'add-link' ? 'button secondary busy' : 'button secondary'} disabled={busy || !torrentAvailable || !looksLikeTorrentLink(torrentLink)}>{busyAction === 'add-link' ? <LoaderCircle className="spin"/> : <Magnet/>}Add link</button></form>{item.status === 'needs-upgrade' && <button className="button secondary" disabled={busy} onClick={() => onStatus('recovered')}><Check/>Mark acceptable</button>}<button className="button danger recovery-delete" disabled={deleteBlocked} onClick={() => setConfirmingDelete(true)}><Trash2/>Delete</button></div>{searching ? <p className="recovery-search-status" role="status"><LoaderCircle className="spin"/>Searching {searching}…</p> : searchNote && <p className={searchNote.error ? 'recovery-search-status error' : 'recovery-search-status'} role="status">{searchNote.error && <AlertTriangle/>}{searchNote.text}</p>}{confirmingDelete && <div className="delete-confirm"><AlertTriangle/><div><strong>Delete this recovery item?</strong><p>{torrentRunning ? 'This stops the torrent and removes it and everything it has downloaded from qBittorrent, then removes the queue entry.' : hasImportedAudio ? importedCount > 1 ? `This will remove all ${importedCount} recovery tracks, their provenance sidecars, and preserved originals. The canonical music library will not be touched.` : 'This will remove the recovery copy, its provenance sidecar, and the preserved original from the recovery library. The canonical music library will not be touched.' : 'This item has no imported audio. Only its queue entry and candidates will be removed.'}</p><div><button className="button secondary" disabled={deleteBlocked} onClick={() => setConfirmingDelete(false)}>Cancel</button><button className="button danger" disabled={deleteBlocked} onClick={onDelete}>{busyAction === 'delete' ? <LoaderCircle className="spin"/> : <Trash2/>}Delete permanently</button></div></div></div>}
      {item.error && <p className="recovery-inline-error">{item.error}</p>}
      {item.candidates.length > 0 && <div className="candidate-list">{item.candidates.map((candidate) => <Fragment key={candidate.id}><div className={candidate.selected ? 'candidate selected' : 'candidate'}><div className="candidate-score"><strong>{candidate.matchScore}%</strong><small>match</small></div><div className="candidate-copy"><strong>{candidate.title}</strong><small>{candidate.channel} · {candidate.duration ? formatDuration(candidate.duration) : candidate.backend === 'usenet' ? 'Provider metadata only' : candidate.backend === 'torrent' ? (isTorrentSearchResult(candidate) ? torrentResultSummary(candidate.provenance?.raw) ?? 'Torrent search result' : 'Pasted link') : 'Unknown duration'}{candidate.official ? ' · Official source signal' : ''}</small>{candidate.importedPath ? <div className="candidate-quality"><span><b>Source audio</b>{candidate.provenance?.importedCount && candidate.provenance.importedCount > 1 ? `${candidate.provenance.importedCount} release tracks preserved` : qualityLabel(candidate)}</span><span><b>Tomify derivative</b>{candidate.provenance?.derivative?.quality ? qualityLabel(candidate.provenance.derivative.quality) : 'None'}{candidate.provenance?.derivative ? ` · ${candidate.provenance.derivative.transcoded ? 'transcoded' : 'audio stream preserved'}` : ''}</span><span><b>Acquisition</b>{candidate.backend === 'internet-archive' ? 'Internet Archive file' : candidate.backend === 'usenet' ? 'Configured indexer via downloader' : candidate.backend === 'torrent' ? (isTorrentSearchResult(candidate) ? 'Torrent search via qBittorrent' : 'Torrent link via qBittorrent') : candidate.provenance?.authenticatedAccessUsed ? 'Authenticated YouTube session' : 'Anonymous YouTube'}{candidate.provenance?.selectedFormatId ? ` · format ${candidate.provenance.selectedFormatId}` : ''}</span><span><b>Archive status</b>{candidate.provenance?.archiveStatus || 'Recovery copy'} · never a verified master</span></div> : candidate.provenance?.job ? <div className="recovery-job-progress"><progress max="100" value={candidate.provenance.job.progress}/><span>{candidate.provenance.job.status} · {candidate.provenance.job.progress}%{candidate.provenance.job.message ? ` · ${candidate.provenance.job.message}` : ''}</span>{torrentTransferSummary(candidate.provenance.job.details) && <span className="recovery-job-transfer">{torrentTransferSummary(candidate.provenance.job.details)}</span>}</div> : <span>{qualityLabel(candidate)}</span>}{candidate.backend === 'internet-archive' && candidate.provenance?.raw && <small>Internet Archive item · verify the item licence and rights before import</small>}{candidate.backend === 'usenet' && <small>Indexer result only · inspect the release details and confirm this specific acquisition is authorised</small>}{candidate.backend === 'torrent' && <small>{isTorrentSearchResult(candidate) ? 'Torrent search result' : 'Pasted torrent link'} · confirm this specific acquisition is authorised. The torrent is removed from qBittorrent once imported.</small>}</div>{(candidate.backend !== 'torrent' || (isTorrentSearchResult(candidate) && /^https?:/i.test(candidate.url))) && <a className="icon-button" href={candidate.url} target="_blank" rel="noreferrer" aria-label={`Open candidate on ${candidate.backend === 'internet-archive' ? 'Internet Archive' : candidate.backend === 'usenet' ? 'the NZB indexer' : candidate.backend === 'torrent' ? 'the torrent site' : 'YouTube'}`}><ExternalLink/></a>}{!candidate.selected && <button className="button secondary" disabled={busy} onClick={() => onSelect(candidate.id)}>Select</button>}{candidate.importedPath && <div className="candidate-actions"><span className="candidate-imported"><Check/>{candidate.provenance?.importedCount && candidate.provenance.importedCount > 1 ? `Imported ${candidate.provenance.importedCount} tracks` : 'Imported'}</span>{canImportRestOfDownload(candidate) && <button className="button secondary" disabled={busy} title="Import the other audio files from this download as an album, without downloading it again" onClick={onImportRemaining}>{busyAction === 'import-remaining' ? <LoaderCircle className="spin"/> : <Plus/>}Import rest of download</button>}</div>}</div>{candidate.selected && importReview}</Fragment>)}</div>}
      
      <p className="provenance-note">Provenance: {selected ? `${sourceLabels[selected.backend]} · ${selected.url} · ${selected.importedPath ? 'measured and tagged' : selected.provenance?.job ? selected.provenance.job.status : 'candidate only'}` : 'not yet established'}.</p>
    </div>}
  </article>
}

function MetadataReview({ item, choices, onChange, artworkCandidateId, onArtworkChange, busy, onContinue }: { item: RecoveryItem; choices: RecoveryMetadataChoices; onChange(choices: RecoveryMetadataChoices): void; artworkCandidateId: string | null; onArtworkChange(id: string | null): void; busy: boolean; onContinue(): void }) {
  const resolution = item.metadataResolution
  const matched = resolution?.metadata
  const toggle = (field: keyof RecoveryMetadataChoices) => onChange({ ...choices, [field]: !choices[field] })
  const track = matched?.trackNumber ? `${matched.discNumber ? `${matched.discNumber}.` : ''}${matched.trackNumber}` : matched?.discNumber ? `Disc ${matched.discNumber}` : '—'
  return <section className={`metadata-review ${resolution?.strong ? 'confirmed' : 'unconfirmed'}`}>
    <header><div><span className="eyebrow">MusicBrainz metadata review</span><strong>{resolution?.strong ? 'Canonical metadata match' : 'Canonical metadata not confirmed'}</strong></div>{matched && <span className="metadata-confidence">{resolution?.confidence ?? 0}% match</span>}</header>
    <div className="metadata-comparison">
      <div><b>Entered</b><dl><dt>Artist</dt><dd>{item.artist || 'Not entered'}</dd><dt>Title</dt><dd>{item.title || 'Not entered'}</dd><dt>Album</dt><dd>{item.album || 'Not entered'}</dd><dt>Track</dt><dd>{item.trackNumber || 'Not entered'}</dd></dl></div>
      <div><b>{resolution?.strong ? 'Matched metadata' : 'Closest result'}</b>{matched ? <dl><dt>Artist</dt><dd>{matched.artist || '—'}</dd><dt>Title</dt><dd>{matched.title || '—'}</dd><dt>Album</dt><dd>{matched.album || '—'}</dd><dt>Release date</dt><dd>{matched.releaseDate || '—'}</dd><dt>Track</dt><dd>{track}</dd></dl> : <p>MusicBrainz did not return a usable recording match.</p>}</div>
    </div>
    {resolution?.strong && matched ? <div className="metadata-toggles">
      <label><input type="checkbox" checked={choices.artist} disabled={!matched.artist} onChange={() => toggle('artist')}/>Use matched artist <span>{matched.artist}</span></label>
      <label><input type="checkbox" checked={choices.title} disabled={!matched.title} onChange={() => toggle('title')}/>Use matched title <span>{matched.title}</span></label>
      <label><input type="checkbox" checked={choices.album} disabled={!matched.album} onChange={() => toggle('album')}/>Use matched album <span>{matched.album || 'Unavailable'}</span></label>
      <label><input type="checkbox" checked={choices.releaseDate} disabled={!matched.releaseDate} onChange={() => toggle('releaseDate')}/>Use matched release date <span>{matched.releaseDate || 'Unavailable'}</span></label>
      <label><input type="checkbox" checked={choices.trackNumbers} disabled={!matched.trackNumber && !matched.discNumber} onChange={() => toggle('trackNumbers')}/>Use matched track/disc numbers <span>{track}</span></label>
    </div> : <p className="metadata-warning">Entered metadata will be used unchanged. Tomify will not apply an ambiguous, weak, or unavailable MusicBrainz result.</p>}
    {matched?.recordingId && <small>MusicBrainz recording {matched.recordingId}{matched.releaseId ? ` · release ${matched.releaseId}` : ''}</small>}
    <div className="artwork-review"><header><div><span className="eyebrow">Artwork</span><strong>{artworkCandidateId ? 'Selected release artwork' : 'No artwork selected'}</strong></div><button className={`button ${artworkCandidateId === null ? 'primary' : 'secondary'}`} onClick={() => onArtworkChange(null)}>No artwork</button></header>
      {item.artworkResolution?.candidates.length ? <div className="artwork-candidates">{item.artworkResolution.candidates.map((candidate) => <article className={artworkCandidateId === candidate.id ? 'artwork-candidate selected' : 'artwork-candidate'} key={candidate.id}><img src={candidate.previewUrl || candidate.url} alt={`${candidate.providerLabel} artwork candidate`} loading="lazy" referrerPolicy="no-referrer"/><div><strong>{candidate.providerLabel}</strong><span>{candidate.width && candidate.height ? `${candidate.width} × ${candidate.height}` : 'Dimensions verified on import'}</span><span>{candidate.quality === 'high' ? 'High quality' : candidate.quality === 'preferred' ? 'Preferred quality' : 'Fallback quality'} · {candidate.confidence}% confidence</span>{candidate.album && <small>{candidate.artist} · {candidate.album}</small>}{candidate.storeUrl && <a href={candidate.storeUrl} target="_blank" rel="noreferrer">Open in {candidate.providerLabel}</a>}{candidate.unavailableReason && <small className="artwork-unavailable">{candidate.unavailableReason}</small>}</div><button className={`button ${artworkCandidateId === candidate.id ? 'primary' : 'secondary'}`} disabled={!candidate.selectable} onClick={() => onArtworkChange(candidate.id)}>{artworkCandidateId === candidate.id ? 'Selected' : 'Use this artwork'}</button></article>)}</div> : <p className="metadata-warning">No viable artwork candidates were found. The track can be imported without artwork.</p>}
      <p className="artwork-note">Provider order: Apple catalogue, optional Spotify, Cover Art Archive, then YouTube thumbnail. Actual MIME type and dimensions are verified by the recovery agent before use.</p>
    </div>
    <div className="recovery-actions metadata-review-actions"><button className="button primary" disabled={busy} onClick={onContinue}>Continue to import</button></div>
  </section>
}
