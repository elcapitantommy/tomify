import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, CircleGauge, ExternalLink, FileAudio, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Trash2, Youtube } from 'lucide-react'
import { recoveryApi } from '../lib/recovery-api'
import { qualityLabel, type RecoveryItem, type RecoveryStatus } from '../lib/recovery'
import { formatDuration } from '../lib/format'

const statusLabels: Record<RecoveryStatus, string> = {
  missing: 'Missing',
  'candidate-found': 'Review candidate',
  importing: 'Importing',
  recovered: 'Recovered',
  'needs-upgrade': 'Needs upgrade',
  failed: 'Failed',
}

export function Recovery() {
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [backends, setBackends] = useState<Array<{ id: string; label: string; available: boolean; authentication?: 'configured' | 'not-configured' | 'unavailable'; reason?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
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
  const counts = useMemo(() => ({
    missing: items.filter((item) => item.status === 'missing' || item.status === 'candidate-found').length,
    recovered: items.filter((item) => item.status === 'recovered').length,
    upgrade: items.filter((item) => item.status === 'needs-upgrade').length,
  }), [items])
  const youtube = backends.find((backend) => backend.id === 'youtube')

  async function addItem(event: React.FormEvent) {
    event.preventDefault()
    if (!form.artist.trim() || !form.title.trim()) return
    setBusyId('new')
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
    finally { setBusyId(null) }
  }

  async function act(id: string, action: () => Promise<{ item: RecoveryItem }>) {
    setBusyId(id); setError(null)
    try {
      const { item } = await action()
      setItems((current) => current.map((value) => value.id === id ? item : value))
      setExpanded(id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery action failed.') }
    finally { setBusyId(null) }
  }

  async function deleteItem(id: string) {
    setBusyId(id); setError(null)
    try {
      await recoveryApi.delete(id)
      setItems((current) => current.filter((value) => value.id !== id))
      setExpanded((current) => current === id ? null : current)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete the recovery item.') }
    finally { setBusyId(null) }
  }

  return <div className="page recovery-page">
    <header className="page-header recovery-header"><div><span className="eyebrow">Collection repair</span><h1>Recovery</h1><p>Rebuild missing music from sources you are authorised to use, with every match and quality decision recorded.</p></div><button className="button primary" onClick={() => setAdding((value) => !value)}><Plus/>Add wanted track</button></header>
    <div className="recovery-stats"><article><Search/><span><strong>{counts.missing}</strong><small>Missing or under review</small></span></article><article><Check/><span><strong>{counts.recovered}</strong><small>Recovered</small></span></article><article><CircleGauge/><span><strong>{counts.upgrade}</strong><small>Needs a better copy</small></span></article></div>
    <div className="recovery-safety"><ShieldCheck/><div><strong>Source-aware by design</strong><p>YouTube is an optional candidate backend. Tomify records the source and requires you to confirm that copying it is authorised. YouTube imports are always marked as lossy recovery copies, never archival masters.</p></div>{youtube?.available && <span className={`youtube-auth ${youtube.authentication ?? 'unavailable'}`}>YouTube authentication: {youtube.authentication === 'configured' ? 'configured' : 'not configured'}</span>}</div>
    {adding && <form className="recovery-form" onSubmit={addItem}><label><span>Artist</span><input required value={form.artist} onChange={(event) => setForm({ ...form, artist: event.target.value })}/></label><label><span>Track</span><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })}/></label><label><span>Release</span><input value={form.album} onChange={(event) => setForm({ ...form, album: event.target.value })}/></label><label><span>Duration (seconds)</span><input min="1" type="number" value={form.duration} onChange={(event) => setForm({ ...form, duration: event.target.value })}/></label><label><span>Track no.</span><input min="1" type="number" value={form.trackNumber} onChange={(event) => setForm({ ...form, trackNumber: event.target.value })}/></label><button className="button primary" disabled={busyId === 'new'}>{busyId === 'new' ? <LoaderCircle className="spin"/> : <Plus/>}Add to queue</button></form>}
    {youtube && !youtube.available && <div className="recovery-backend-note"><AlertTriangle/><span><strong>YouTube search is not connected.</strong> {youtube.reason ?? 'Configure the optional recovery agent to search and inspect candidates.'}</span></div>}
    {error && <div className="login-error recovery-error">{error}</div>}
    {loading ? <div className="state-card"><LoaderCircle className="spin"/><h2>Loading recovery queue</h2></div> : items.length === 0 ? <div className="state-card"><FileAudio/><h2>No missing tracks queued</h2><p>Add a track or release you want Tomify to help recover.</p></div> : <div className="recovery-list">{items.map((item) => <RecoveryRow key={item.id} item={item} expanded={expanded === item.id} busy={busyId === item.id} youtubeAvailable={youtube?.available === true} onToggle={() => setExpanded(expanded === item.id ? null : item.id)} onSearch={() => void act(item.id, () => recoveryApi.search(item.id))} onSelect={(candidateId) => void act(item.id, () => recoveryApi.select(item.id, candidateId))} onAcquire={(candidateId, rightsBasis) => void act(item.id, () => recoveryApi.acquire(item.id, candidateId, rightsBasis))} onStatus={(status) => void act(item.id, () => recoveryApi.updateStatus(item.id, status))} onDelete={() => void deleteItem(item.id)}/>)}</div>}
  </div>
}

function RecoveryRow({ item, expanded, busy, youtubeAvailable, onToggle, onSearch, onSelect, onAcquire, onStatus, onDelete }: { item: RecoveryItem; expanded: boolean; busy: boolean; youtubeAvailable: boolean; onToggle(): void; onSearch(): void; onSelect(id: string): void; onAcquire(id: string, rights: string): void; onStatus(status: RecoveryStatus): void; onDelete(): void }) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [rights, setRights] = useState('')
  const selected = item.candidates.find((candidate) => candidate.selected)
  const hasImportedAudio = item.candidates.some((candidate) => Boolean(candidate.importedPath))
  return <article className="recovery-row">
    <button className="recovery-summary" onClick={onToggle}><span className={`recovery-status ${item.status}`}>{statusLabels[item.status]}</span><span className="recovery-title"><strong>{item.title}</strong><small>{item.artist}{item.album ? ` · ${item.album}` : ''}</small></span><span className="recovery-source">{selected ? <><Youtube/>{selected.channel}</> : 'No source selected'}</span><span className="recovery-quality">{selected ? qualityLabel(selected) : item.duration ? formatDuration(item.duration) : '—'}</span>{expanded ? <ChevronUp/> : <ChevronDown/>}</button>
    {expanded && <div className="recovery-detail"><div className="recovery-actions"><button className="button secondary" disabled={busy || !youtubeAvailable} onClick={onSearch}>{busy ? <LoaderCircle className="spin"/> : <RefreshCw/>}{item.candidates.length ? 'Search again' : 'Find YouTube candidates'}</button>{item.status === 'needs-upgrade' && <button className="button secondary" disabled={busy} onClick={() => onStatus('recovered')}><Check/>Mark acceptable</button>}<button className="button danger recovery-delete" disabled={busy} onClick={() => setConfirmingDelete(true)}><Trash2/>Delete</button></div>
      {item.error && <p className="recovery-inline-error">{item.error}</p>}
      {item.candidates.length > 0 && <div className="candidate-list">{item.candidates.map((candidate) => <div className={candidate.selected ? 'candidate selected' : 'candidate'} key={candidate.id}><div className="candidate-score"><strong>{candidate.matchScore}%</strong><small>match</small></div><div className="candidate-copy"><strong>{candidate.title}</strong><small>{candidate.channel} · {candidate.duration ? formatDuration(candidate.duration) : 'Unknown duration'}{candidate.official ? ' · Official source signal' : ''}</small>{candidate.importedPath ? <div className="candidate-quality"><span><b>Source audio</b>{qualityLabel(candidate)}</span><span><b>Tomify derivative</b>{candidate.provenance?.derivative?.quality ? qualityLabel(candidate.provenance.derivative.quality) : 'None'}{candidate.provenance?.derivative ? ` · ${candidate.provenance.derivative.transcoded ? 'transcoded' : 'audio stream preserved'}` : ''}</span><span><b>Acquisition</b>{candidate.provenance?.authenticatedAccessUsed ? 'Authenticated YouTube session' : 'Anonymous YouTube'}{candidate.provenance?.selectedFormatId ? ` · format ${candidate.provenance.selectedFormatId}` : ''}</span><span><b>Archive status</b>Lossy recovery copy · never a verified master</span></div> : <span>{qualityLabel(candidate)}</span>}</div><a className="icon-button" href={candidate.url} target="_blank" rel="noreferrer" aria-label="Open candidate on YouTube"><ExternalLink/></a>{!candidate.selected && <button className="button secondary" disabled={busy} onClick={() => onSelect(candidate.id)}>Select</button>}{candidate.selected && !candidate.importedPath && <button className="button primary" disabled={busy} onClick={() => setConfirming(candidate.id)}>Import</button>}{candidate.importedPath && <span className="candidate-imported"><Check/>Imported</span>}</div>)}</div>}
      {confirming && <div className="rights-confirm"><ShieldCheck/><div><strong>Confirm this source can be copied</strong><p>Owning the physical release does not automatically authorise downloading an unrelated upload. State why this specific source is authorised.</p><select value={rights} onChange={(event) => setRights(event.target.value)}><option value="">Choose a basis…</option><option value="uploader-authorised">Uploader/rights holder permits downloads</option><option value="creative-commons">Creative Commons licence permits this use</option><option value="public-domain">Public domain</option><option value="other-authorisation">Other explicit authorisation</option></select><div><button className="button secondary" onClick={() => { setConfirming(null); setRights('') }}>Cancel</button><button className="button primary" disabled={!rights || busy} onClick={() => { onAcquire(confirming, rights); setConfirming(null); setRights('') }}>Confirm and import</button></div></div></div>}
      {confirmingDelete && <div className="delete-confirm"><AlertTriangle/><div><strong>Delete this recovery item?</strong><p>{hasImportedAudio ? 'This will remove the recovery copy, its provenance sidecar, and the preserved original from the recovery library. The canonical music library will not be touched.' : 'This item has no imported audio. Only its queue entry and candidates will be removed.'}</p><div><button className="button secondary" disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button><button className="button danger" disabled={busy} onClick={onDelete}>{busy ? <LoaderCircle className="spin"/> : <Trash2/>}Delete permanently</button></div></div></div>}
      <p className="provenance-note">Provenance: {selected ? `YouTube · ${selected.url} · ${selected.importedPath ? 'measured and tagged' : 'candidate only'}` : 'not yet established'}.</p>
    </div>}
  </article>
}
