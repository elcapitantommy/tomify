import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, CircleGauge, ExternalLink, FileAudio, Landmark, LoaderCircle, Plus, Search, Server, ShieldCheck, Trash2, Youtube } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { recoveryApi } from '../lib/recovery-api'
import { qualityLabel, type RecoveryBackend, type RecoveryItem, type RecoveryMetadataChoices, type RecoverySearchMode, type RecoveryStatus } from '../lib/recovery'
import { formatDuration } from '../lib/format'

const statusLabels: Record<RecoveryStatus, string> = {
  missing: 'Missing',
  'candidate-found': 'Review candidate',
  importing: 'Importing',
  queued: 'Queued',
  downloading: 'Downloading',
  recovered: 'Recovered',
  'needs-upgrade': 'Needs upgrade',
  failed: 'Failed',
}

type RecoveryBusyAction = 'add' | 'search-youtube' | 'search-internet-archive' | 'search-usenet' | 'select' | 'acquire' | 'status' | 'delete'
type RecoveryBusyState = { id: string; action: RecoveryBusyAction } | null

export function Recovery() {
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [backends, setBackends] = useState<Array<{ id: string; label: string; available: boolean; authentication?: 'configured' | 'not-configured' | 'not-required' | 'unavailable'; reason?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<RecoveryBusyState>(null)
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

  async function addItem(event: React.FormEvent) {
    event.preventDefault()
    if (!form.artist.trim() || !form.title.trim()) return
    setBusy({ id: 'new', action: 'add' })
    setError(null)
    try {
      const { item } = await recoveryApi.add({
        artist: form.artist.trim(), title: form.title.trim(), album: form.album.trim() || undefined,
        duration: form.duration ? Number(form.duration) : undefined,
        trackNumber: form.trackNumber ? Number(form.trackNumber) : undefined,
      })
      setItems((current) => [item, ...current])
      setForm({ artist: '', title: '', album: '', duration: '', trackNumber: '' })
      setAdding(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the track.') }
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
    <header className="page-header recovery-header"><div><span className="eyebrow">Collection repair</span><h1>Recovery</h1><p>Rebuild missing music from sources you are authorised to use, with every match and quality decision recorded.</p></div><button className="button primary" onClick={() => setAdding((value) => !value)}><Plus/>Add wanted track</button></header>
    <div className="recovery-stats"><article><Search/><span><strong>{counts.missing}</strong><small>Missing or under review</small></span></article><article><Check/><span><strong>{counts.recovered}</strong><small>Recovered</small></span></article><article><CircleGauge/><span><strong>{counts.upgrade}</strong><small>Needs a better copy</small></span></article></div>
    <div className="recovery-safety"><ShieldCheck/><div><strong>Source-aware by design</strong><p>YouTube and Internet Archive are optional candidate sources. Tomify records the source and requires you to confirm that copying it is authorised. Recovery imports are never treated as verified archival masters.</p></div>{youtube?.available && <span className={`youtube-auth ${youtube.authentication ?? 'unavailable'}`}>YouTube authentication: {youtube.authentication === 'configured' ? 'configured' : 'not configured'}</span>}</div>
    {adding && <form className="recovery-form" onSubmit={addItem}><label><span>Artist</span><input required value={form.artist} onChange={(event) => setForm({ ...form, artist: event.target.value })}/></label><label><span>Track</span><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })}/></label><label><span>Release</span><input value={form.album} onChange={(event) => setForm({ ...form, album: event.target.value })}/></label><label><span>Duration (seconds)</span><input min="1" type="number" value={form.duration} onChange={(event) => setForm({ ...form, duration: event.target.value })}/></label><label><span>Track no.</span><input min="1" type="number" value={form.trackNumber} onChange={(event) => setForm({ ...form, trackNumber: event.target.value })}/></label><button className="button primary" disabled={busy !== null}>{busy?.action === 'add' ? <LoaderCircle className="spin"/> : <Plus/>}Add to queue</button></form>}
    {youtube && !youtube.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>YouTube search is not connected.</strong> {youtube.reason ?? 'Configure the optional recovery agent to search and inspect candidates.'}</span></div>}
    {internetArchive && !internetArchive.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>Internet Archive search is not connected.</strong> {internetArchive.reason ?? 'Configure the recovery agent to search and inspect candidates.'}</span></div>}
    {usenet && !usenet.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>Usenet Recovery is not connected.</strong> {usenet.reason ?? 'Configure Newznab or NZBIndex, plus SABnzbd or NZBGet, on the recovery agent.'}</span></div>}
    {error && <div className="login-error recovery-error">{error}</div>}
    {loading ? <div className="state-card"><LoaderCircle className="spin"/><h2>Loading recovery queue</h2></div> : items.length === 0 ? <div className="state-card"><FileAudio/><h2>No missing tracks queued</h2><p>Add a track or release you want Tomify to help recover.</p></div> : <div className="recovery-list">{items.map((item) => <RecoveryRow key={item.id} item={item} expanded={expanded === item.id} busyAction={busy?.id === item.id ? busy.action : null} youtubeAvailable={youtube?.available === true} archiveAvailable={internetArchive?.available === true} usenetAvailable={usenet?.available === true} onToggle={() => setExpanded(expanded === item.id ? null : item.id)} onSearch={(backend, searchMode) => void act(item.id, backend === 'youtube' ? 'search-youtube' : backend === 'internet-archive' ? 'search-internet-archive' : 'search-usenet', () => recoveryApi.search(item.id, backend, searchMode))} onSelect={(candidateId) => void act(item.id, 'select', () => recoveryApi.select(item.id, candidateId))} onAcquire={(candidateId, rightsBasis, metadataChoices, artworkCandidateId) => void act(item.id, 'acquire', () => recoveryApi.acquire(item.id, candidateId, rightsBasis, metadataChoices, artworkCandidateId))} onStatus={(status) => void act(item.id, 'status', () => recoveryApi.updateStatus(item.id, status))} onDelete={() => void deleteItem(item.id)}/>)}</div>}
  </div>
}

function RecoveryRow({ item, expanded, busyAction, youtubeAvailable, archiveAvailable, usenetAvailable, onToggle, onSearch, onSelect, onAcquire, onStatus, onDelete }: { item: RecoveryItem; expanded: boolean; busyAction: RecoveryBusyAction | null; youtubeAvailable: boolean; archiveAvailable: boolean; usenetAvailable: boolean; onToggle(): void; onSearch(backend: RecoveryBackend, mode?: RecoverySearchMode): void; onSelect(id: string): void; onAcquire(id: string, rights: string, metadataChoices: RecoveryMetadataChoices, artworkCandidateId: string | null): void; onStatus(status: RecoveryStatus): void; onDelete(): void }) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [rights, setRights] = useState('')
  const [metadataChoices, setMetadataChoices] = useState<RecoveryMetadataChoices>({ artist: false, title: false, album: false, releaseDate: false, trackNumbers: false })
  const [artworkCandidateId, setArtworkCandidateId] = useState<string | null>(null)
  const [usenetSearchMode, setUsenetSearchMode] = useState<RecoverySearchMode>('track')
  const selected = item.candidates.find((candidate) => candidate.selected)
  const busy = busyAction !== null || item.status === 'queued' || item.status === 'downloading'
  const hasImportedAudio = item.candidates.some((candidate) => Boolean(candidate.importedPath))
  const resolution = item.metadataResolution?.candidateId === selected?.id ? item.metadataResolution : null
  const matched = resolution?.metadata
  useEffect(() => {
    const enabled = resolution?.strong === true
    setMetadataChoices({ artist: enabled && Boolean(matched?.artist), title: enabled && Boolean(matched?.title), album: enabled && Boolean(matched?.album), releaseDate: enabled && Boolean(matched?.releaseDate), trackNumbers: enabled && Boolean(matched?.trackNumber || matched?.discNumber) })
  }, [resolution?.resolvedAt, resolution?.strong, matched?.artist, matched?.title, matched?.album, matched?.releaseDate, matched?.trackNumber, matched?.discNumber])
  useEffect(() => { setArtworkCandidateId(item.artworkResolution?.selectedCandidateId || null) }, [item.artworkResolution?.resolvedAt, item.artworkResolution?.selectedCandidateId])
  return <article className="recovery-row">
    <button className="recovery-summary" onClick={onToggle}><span className={`recovery-status ${item.status}`}>{statusLabels[item.status]}</span><span className="recovery-title"><strong>{item.title}</strong><small>{item.artist}{item.album ? ` · ${item.album}` : ''}</small></span><span className="recovery-source">{selected ? <>{selected.backend === 'internet-archive' ? <Landmark/> : selected.backend === 'usenet' ? <Server/> : <Youtube/>}{selected.channel}</> : 'No source selected'}</span><span className="recovery-quality">{selected?.provenance?.job && !selected.importedPath ? `${selected.provenance.job.progress}% · ${selected.provenance.job.status}` : selected ? qualityLabel(selected) : item.duration ? formatDuration(item.duration) : '—'}</span>{expanded ? <ChevronUp/> : <ChevronDown/>}</button>
    {expanded && <div className="recovery-detail"><div className="recovery-actions"><button className="button secondary" disabled={busy || !youtubeAvailable} onClick={() => onSearch('youtube')}>{busyAction === 'search-youtube' ? <LoaderCircle className="spin"/> : <Youtube/>}Search YouTube</button><button className="button secondary" disabled={busy || !archiveAvailable} onClick={() => onSearch('internet-archive')}>{busyAction === 'search-internet-archive' ? <LoaderCircle className="spin"/> : <Landmark/>}Search Internet Archive</button><span className="usenet-search-control"><select aria-label="Usenet search mode" value={usenetSearchMode} onChange={(event) => setUsenetSearchMode(event.target.value as RecoverySearchMode)}><option value="artist">Artist only</option><option value="track">Track title only</option><option value="release">Release / album only</option></select><button className="button secondary" disabled={busy || !usenetAvailable || (usenetSearchMode === 'release' && !item.album)} onClick={() => onSearch('usenet', usenetSearchMode)}>{busyAction === 'search-usenet' ? <LoaderCircle className="spin"/> : <Server/>}Search NZB</button></span>{item.status === 'needs-upgrade' && <button className="button secondary" disabled={busy} onClick={() => onStatus('recovered')}><Check/>Mark acceptable</button>}<button className="button danger recovery-delete" disabled={busy} onClick={() => setConfirmingDelete(true)}><Trash2/>Delete</button></div>
      {item.error && <p className="recovery-inline-error">{item.error}</p>}
      {item.candidates.length > 0 && <div className="candidate-list">{item.candidates.map((candidate) => <div className={candidate.selected ? 'candidate selected' : 'candidate'} key={candidate.id}><div className="candidate-score"><strong>{candidate.matchScore}%</strong><small>match</small></div><div className="candidate-copy"><strong>{candidate.title}</strong><small>{candidate.channel} · {candidate.duration ? formatDuration(candidate.duration) : candidate.backend === 'usenet' ? 'Provider metadata only' : 'Unknown duration'}{candidate.official ? ' · Official source signal' : ''}</small>{candidate.importedPath ? <div className="candidate-quality"><span><b>Source audio</b>{qualityLabel(candidate)}</span><span><b>Tomify derivative</b>{candidate.provenance?.derivative?.quality ? qualityLabel(candidate.provenance.derivative.quality) : 'None'}{candidate.provenance?.derivative ? ` · ${candidate.provenance.derivative.transcoded ? 'transcoded' : 'audio stream preserved'}` : ''}</span><span><b>Acquisition</b>{candidate.backend === 'internet-archive' ? 'Internet Archive file' : candidate.backend === 'usenet' ? 'Configured indexer via downloader' : candidate.provenance?.authenticatedAccessUsed ? 'Authenticated YouTube session' : 'Anonymous YouTube'}{candidate.provenance?.selectedFormatId ? ` · format ${candidate.provenance.selectedFormatId}` : ''}</span><span><b>Archive status</b>{candidate.provenance?.archiveStatus || 'Recovery copy'} · never a verified master</span></div> : candidate.provenance?.job ? <div className="recovery-job-progress"><progress max="100" value={candidate.provenance.job.progress}/><span>{candidate.provenance.job.status} · {candidate.provenance.job.progress}%{candidate.provenance.job.message ? ` · ${candidate.provenance.job.message}` : ''}</span></div> : <span>{qualityLabel(candidate)}</span>}{candidate.backend === 'internet-archive' && candidate.provenance?.raw && <small>Internet Archive item · verify the item licence and rights before import</small>}{candidate.backend === 'usenet' && <small>Indexer result only · inspect the release details and confirm this specific acquisition is authorised</small>}</div><a className="icon-button" href={candidate.url} target="_blank" rel="noreferrer" aria-label={`Open candidate on ${candidate.backend === 'internet-archive' ? 'Internet Archive' : candidate.backend === 'usenet' ? 'the NZB indexer' : 'YouTube'}`}><ExternalLink/></a>{!candidate.selected && <button className="button secondary" disabled={busy} onClick={() => onSelect(candidate.id)}>Select</button>}{candidate.importedPath && <span className="candidate-imported"><Check/>Imported</span>}</div>)}</div>}
      {selected && !selected.importedPath && resolution && <MetadataReview item={item} choices={metadataChoices} onChange={setMetadataChoices} artworkCandidateId={artworkCandidateId} onArtworkChange={setArtworkCandidateId} busy={busy} onContinue={() => setConfirming(selected.id)}/>}
      {confirming && <div className="rights-confirm"><ShieldCheck/><div><strong>Confirm this source can be copied</strong><p>Owning the physical release does not automatically authorise downloading an unrelated upload. State why this specific source is authorised.</p><select value={rights} onChange={(event) => setRights(event.target.value)}><option value="">Choose a basis…</option><option value="uploader-authorised">Uploader/rights holder permits downloads</option><option value="creative-commons">Creative Commons licence permits this use</option><option value="public-domain">Public domain</option><option value="other-authorisation">Other explicit authorisation</option></select><div><button className="button secondary" onClick={() => { setConfirming(null); setRights('') }}>Cancel</button><button className="button primary" disabled={!rights || busy} onClick={() => { onAcquire(confirming, rights, metadataChoices, artworkCandidateId); setConfirming(null); setRights('') }}>Confirm and import</button></div></div></div>}
      {confirmingDelete && <div className="delete-confirm"><AlertTriangle/><div><strong>Delete this recovery item?</strong><p>{hasImportedAudio ? 'This will remove the recovery copy, its provenance sidecar, and the preserved original from the recovery library. The canonical music library will not be touched.' : 'This item has no imported audio. Only its queue entry and candidates will be removed.'}</p><div><button className="button secondary" disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button><button className="button danger" disabled={busy} onClick={onDelete}>{busyAction === 'delete' ? <LoaderCircle className="spin"/> : <Trash2/>}Delete permanently</button></div></div></div>}
      <p className="provenance-note">Provenance: {selected ? `${selected.backend === 'internet-archive' ? 'Internet Archive' : selected.backend === 'usenet' ? 'Usenet indexer' : 'YouTube'} · ${selected.url} · ${selected.importedPath ? 'measured and tagged' : selected.provenance?.job ? selected.provenance.job.status : 'candidate only'}` : 'not yet established'}.</p>
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
      <div><b>Entered</b><dl><dt>Artist</dt><dd>{item.artist}</dd><dt>Title</dt><dd>{item.title}</dd><dt>Album</dt><dd>{item.album || 'Not entered'}</dd><dt>Track</dt><dd>{item.trackNumber || 'Not entered'}</dd></dl></div>
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
