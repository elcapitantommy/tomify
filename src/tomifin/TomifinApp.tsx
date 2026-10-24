import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleCheck, Clapperboard, ShieldAlert, ShieldCheck, ShieldQuestion, ExternalLink, FileDown, Link2, LoaderCircle, Lock, LockKeyhole, LogOut, Magnet, Newspaper, Pause, Play, RefreshCw, RotateCcw, Search, TriangleAlert, Upload, UserRound, Users, X } from 'lucide-react'
import { DESTINATIONS, formatAge, formatEta, formatSize, formatSpeed, readFileBase64, tomifinApi, TomifinRequestError, type TomifinDestination, type TomifinDetected, type TomifinJob, type TomifinJobAction, type TomifinKind, type TomifinResult, type TomifinServiceStatus, type TomifinVpnStatus } from './api'
import { sortResults, type SortKey } from './results'

type TomifinUser = { name: string }
const ACTIVE_POLL_MS = 3000
const IDLE_POLL_MS = 15000
const KINDS: Array<{ id: TomifinKind; label: string }> = [{ id: 'video', label: 'Films & TV' }, { id: 'movies', label: 'Films' }, { id: 'tv', label: 'TV' }]
const RESOLUTIONS = ['2160p', '1080p', '720p'] as const
const STATUS_LABELS: Record<TomifinJob['status'], string> = { queued: 'Queued', downloading: 'Downloading', stalled: 'Stalled', paused: 'Paused', completed: 'Completed', failed: 'Failed' }
const DETECTED_LABELS: Record<TomifinDetected, string> = { magnet: 'Torrent · Magnet link', torrent: 'Torrent · .torrent file', nzb: 'Usenet · NZB' }

function TypeBadge({ result }: { result: TomifinResult }) {
  if (result.type === 'usenet') return <span className="tf-chip tf-chip-usenet" title="NZB, downloaded with SABnzbd"><Newspaper aria-hidden/>Usenet · NZB</span>
  return <span className="tf-chip tf-chip-type" title={result.linkType === 'magnet' ? 'Magnet link' : '.torrent file'}>{result.linkType === 'magnet' ? <Magnet aria-hidden/> : <FileDown aria-hidden/>}Torrent · {result.linkType === 'magnet' ? 'Magnet' : 'File'}</span>
}

function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong.' }

function SignIn({ onSignedIn }: { onSignedIn: (user: TomifinUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setError(null)
    try { const { user } = await tomifinApi.signIn(username, password); setPassword(''); onSignedIn(user) }
    catch (failure) { setError(message(failure)) }
    finally { setBusy(false) }
  }
  return (
    <section className="tf-panel tf-signin" aria-labelledby="tf-signin-title">
      <h2 id="tf-signin-title">Sign in</h2>
      <p>Use your Jellyfin account. Tomifin is for Jellyfin administrators.</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label><span>Jellyfin username</span><div className="tf-input"><UserRound aria-hidden/><input value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false}/></div></label>
        <label><span>Password</span><div className="tf-input"><LockKeyhole aria-hidden/><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password"/></div></label>
        {error && <div className="tf-alert tf-alert-error" role="alert"><TriangleAlert aria-hidden/>{error}</div>}
        <button className="tf-button tf-primary tf-wide" disabled={busy}>{busy ? <><LoaderCircle className="tf-spin" aria-hidden/>Signing in…</> : 'Sign in'}</button>
      </form>
    </section>
  )
}

function DestinationPicker({ value, onChange, status }: { value: TomifinDestination | null; onChange: (value: TomifinDestination) => void; status: TomifinServiceStatus | null }) {
  return (
    <section className="tf-panel" aria-labelledby="tf-destination-title" id="tf-destination">
      <div className="tf-section-head"><h2 id="tf-destination-title">Save to</h2><span className="tf-muted">Choose a library before queuing.</span></div>
      <div className="tf-destinations" role="group" aria-label="Download destination">
        {(Object.keys(DESTINATIONS) as TomifinDestination[]).map((id) => {
          const destination = DESTINATIONS[id]
          const available = status?.destinations.find((entry) => entry.id === id)?.available !== false
          const Icon = id === 'family' ? Users : Lock
          return (
            <button key={id} type="button" className={`tf-destination tf-destination-${id}${value === id ? ' tf-selected' : ''}`} aria-pressed={value === id} disabled={!available} onClick={() => onChange(id)}>
              <Icon aria-hidden/>
              <span><strong>{destination.label.toUpperCase()}</strong><code>{destination.path}</code></span>
              {value === id && <CircleCheck className="tf-check" aria-hidden/>}
            </button>
          )
        })}
      </div>
      <p className={`tf-selection${value ? '' : ' tf-selection-none'}`} aria-live="polite">
        {value ? <>Downloads will be saved to <strong>{DESTINATIONS[value].label}</strong> (<code>{DESTINATIONS[value].path}</code>).</> : 'No destination selected yet.'}
      </p>
    </section>
  )
}

function Quality({ result }: { result: TomifinResult }) {
  const { resolution, hdr, codec, source } = result.quality
  const tags = [resolution, hdr, codec, source].filter((value): value is string => Boolean(value))
  return <>{tags.map((tag) => <span key={tag} className={`tf-chip${tag === 'CAM' ? ' tf-chip-warn' : ''}`}>{tag}</span>)}</>
}

function ResultCard({ result, destination, busy, queued, onQueue }: { result: TomifinResult; destination: TomifinDestination | null; busy: boolean; queued: boolean; onQueue: (result: TomifinResult) => void }) {
  return (
    <li className="tf-result">
      <div className="tf-result-main">
        <div className="tf-badges">
          <TypeBadge result={result}/>
          <Quality result={result}/>
        </div>
        <h3 className="tf-result-title">{result.title}</h3>
        <dl className="tf-stats">
          <div><dt>Source</dt><dd>{result.source}{result.detailsUrl && <a className="tf-details" href={result.detailsUrl} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Details for ${result.title}`} title="Details"><ExternalLink aria-hidden/></a>}</dd></div>
          <div><dt>Size</dt><dd>{formatSize(result.size)}</dd></div>
          {result.type === 'usenet' ? <>
            <div><dt>Age</dt><dd>{formatAge(result.ageDays)}</dd></div>
            <div><dt>Grabs</dt><dd>{result.grabs ?? '—'}</dd></div>
          </> : <>
            <div><dt>Seeders</dt><dd className="tf-seeders">{result.seeders ?? '—'}</dd></div>
            <div><dt>Leechers</dt><dd>{result.leechers ?? '—'}</dd></div>
          </>}
        </dl>
      </div>
      <button type="button" className={`tf-button tf-queue${destination ? ' tf-primary' : ''}`} disabled={busy || queued} onClick={() => onQueue(result)}>
        {busy ? <><LoaderCircle className="tf-spin" aria-hidden/>Queuing…</> : queued ? <><CircleCheck aria-hidden/>Queued</> : destination ? `Queue to ${DESTINATIONS[destination].label}` : 'Queue'}
      </button>
    </li>
  )
}

function JobCard({ job, onAction, busy }: { job: TomifinJob; onAction: (job: TomifinJob, action: TomifinJobAction) => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const done = job.status === 'completed'
  return (
    <li className={`tf-job tf-job-${job.status}`}>
      <div className="tf-job-head">
        <h3>{job.name}</h3>
        <span className={`tf-pill tf-pill-${job.status}`}>{STATUS_LABELS[job.status]}</span>
      </div>
      <div className="tf-job-meta">
        <span className={`tf-chip tf-chip-${job.destination}`}>{job.destination === 'private' ? <Lock aria-hidden/> : <Users aria-hidden/>}{job.destinationLabel}</span>
        <span className={`tf-chip ${job.downloader === 'sabnzbd' ? 'tf-chip-usenet' : 'tf-chip-type'}`}>{job.downloader === 'sabnzbd' ? <><Newspaper aria-hidden/>Usenet · SABnzbd</> : <><Magnet aria-hidden/>Torrent · qBittorrent</>}</span>
        {job.message && job.status !== 'paused' && <span className="tf-muted">{job.message}</span>}
      </div>
      <div className="tf-progress" role="progressbar" aria-label={`${job.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}><span style={{ width: `${job.progress}%` }}/></div>
      <dl className="tf-stats tf-job-stats">
        <div><dt>Progress</dt><dd>{job.progress.toFixed(job.progress % 1 ? 1 : 0)}%</dd></div>
        <div><dt>Downloaded</dt><dd>{formatSize(job.downloaded)} of {formatSize(job.size)}</dd></div>
        <div><dt>Speed</dt><dd>{done ? '—' : formatSpeed(job.downloadSpeed)}</dd></div>
        <div><dt>Time left</dt><dd>{done ? 'Done' : formatEta(job.eta)}</dd></div>
      </dl>
      <div className="tf-job-actions">
        {job.canPause && <button type="button" className="tf-button" disabled={busy} onClick={() => onAction(job, 'pause')}><Pause aria-hidden/>Pause</button>}
        {job.canResume && <button type="button" className="tf-button" disabled={busy} onClick={() => onAction(job, 'resume')}><Play aria-hidden/>Resume</button>}
        {job.canRetry && <button type="button" className="tf-button" disabled={busy} onClick={() => onAction(job, 'retry')} title={job.retryHint || (job.downloader === 'sabnzbd' ? 'Ask SABnzbd to try this download again' : 'Check the files again and restart the torrent in qBittorrent')}><RotateCcw aria-hidden/>Retry</button>}
        {!confirming && <button type="button" className="tf-button tf-ghost" disabled={busy} onClick={() => setConfirming(true)}><X aria-hidden/>{done || job.status === 'failed' ? 'Remove' : 'Cancel'}</button>}
        {confirming && (
          <div className="tf-confirm" role="group" aria-label="Confirm">
            <span>{done ? 'Remove from this list? The files stay in the library.' : job.keepsFilesOnCancel ? `Remove from ${job.downloaderLabel || 'qBittorrent'}? Any files already saved are kept.` : 'Cancel and delete the partial download?'}</span>
            <button type="button" className="tf-button tf-danger" disabled={busy} onClick={() => { setConfirming(false); onAction(job, 'cancel') }}>{done || job.status === 'failed' ? 'Yes, remove' : 'Yes, cancel'}</button>
            <button type="button" className="tf-button tf-ghost" onClick={() => setConfirming(false)}>Keep</button>
          </div>
        )}
      </div>
    </li>
  )
}

// Add link: a magnet, a direct .torrent or .nzb link, or an uploaded file. The media server works out what it is and
// checks it; it then joins the downloads like a search result.
function AddLink({ destination, disabled, onChecked, onQueue, needDestination }: { destination: TomifinDestination | null; disabled: boolean; onChecked: (result: TomifinResult, detected: TomifinDetected) => void; onQueue: (result: TomifinResult, detected: TomifinDetected) => Promise<boolean>; needDestination: () => void }) {
  const [link, setLink] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [checked, setChecked] = useState<{ detected: TomifinDetected; result: TomifinResult } | null>(null)
  const [busy, setBusy] = useState<'check' | 'add' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const reset = () => { setChecked(null); setError(null) }
  const check = async () => {
    if (!link.trim() && !file) { setError('Paste a link, or choose a .torrent or .nzb file.'); return null }
    setError(null)
    try {
      const response = await tomifinApi.addLink(file ? { file: { name: file.name, data: await readFileBase64(file) } } : { link: link.trim() })
      setChecked(response); onChecked(response.result, response.detected)
      return response
    } catch (failure) { setError(message(failure)); return null }
  }
  const add = async () => {
    if (!destination) { needDestination(); return }
    setBusy('add')
    try {
      const current = checked || await check()
      if (current && await onQueue(current.result, current.detected)) { setLink(''); setFile(null); setChecked(null); if (fileInput.current) fileInput.current.value = '' }
    } finally { setBusy(null) }
  }
  return (
    <section className="tf-panel" aria-labelledby="tf-add-title">
      <div className="tf-section-head"><h2 id="tf-add-title">Add link</h2><span className="tf-muted">A magnet, a .torrent or .nzb link, or a file.</span></div>
      <form className="tf-add" onSubmit={(event) => { event.preventDefault(); void add() }}>
        <div className="tf-input"><Link2 aria-hidden/><input aria-label="Magnet, .torrent or .nzb link" placeholder="magnet:?xt=… or https://…/file.torrent" value={link} disabled={Boolean(file) || disabled} onChange={(event) => { setLink(event.target.value); reset() }} spellCheck={false} autoCapitalize="none" autoComplete="off" maxLength={8000}/></div>
        <div className="tf-add-actions">
          <label className="tf-button tf-ghost tf-file" title="Upload a .torrent or .nzb file">
            <Upload aria-hidden/>{file ? file.name : 'Choose file'}
            <input ref={fileInput} type="file" accept=".torrent,.nzb,application/x-bittorrent,application/x-nzb" className="tf-visually-hidden" aria-label="Upload a .torrent or .nzb file" disabled={disabled} onChange={(event) => { setFile(event.target.files?.[0] || null); setLink(''); reset() }}/>
          </label>
          <button type="button" className="tf-button" disabled={disabled || busy !== null} onClick={() => { setBusy('check'); void check().finally(() => setBusy(null)) }}>{busy === 'check' ? <><LoaderCircle className="tf-spin" aria-hidden/>Checking…</> : 'Check'}</button>
          <button type="submit" className={`tf-button${destination ? ' tf-primary' : ''}`} disabled={disabled || busy !== null}>{busy === 'add' ? <><LoaderCircle className="tf-spin" aria-hidden/>Adding…</> : destination ? `Add to ${DESTINATIONS[destination].label}` : 'Add'}</button>
        </div>
      </form>
      {checked && <p className="tf-detected" role="status"><CircleCheck aria-hidden/>Detected: <strong>{DETECTED_LABELS[checked.detected]}</strong> · {checked.result.title}{checked.result.size ? ` · ${formatSize(checked.result.size)}` : ''}</p>}
      {error && <div className="tf-alert tf-alert-error" role="alert"><TriangleAlert aria-hidden/>{error}</div>}
    </section>
  )
}

function Downloads({ jobs, loading, error, onRefresh, onAction, busyId }: { jobs: TomifinJob[] | null; loading: boolean; error: string | null; onRefresh: () => void; onAction: (job: TomifinJob, action: TomifinJobAction) => void; busyId: string | null }) {
  return (
    <section className="tf-panel" aria-labelledby="tf-downloads-title">
      <div className="tf-section-head">
        <h2 id="tf-downloads-title">Downloads</h2>
        <button type="button" className="tf-button tf-ghost tf-small" onClick={onRefresh} disabled={loading} aria-label="Refresh downloads"><RefreshCw className={loading ? 'tf-spin' : ''} aria-hidden/>Refresh</button>
      </div>
      {error && <div className="tf-alert tf-alert-error" role="alert"><TriangleAlert aria-hidden/>{error}</div>}
      {jobs === null && !error && <p className="tf-empty"><LoaderCircle className="tf-spin" aria-hidden/>Loading downloads…</p>}
      {jobs?.length === 0 && <p className="tf-empty">Nothing queued yet. Search above or add a link, pick Family or Private, then queue it.</p>}
      {Boolean(jobs?.length) && <ul className="tf-jobs">{jobs!.map((job) => <JobCard key={job.id} job={job} busy={busyId === job.id} onAction={onAction}/>)}</ul>}
    </section>
  )
}

// One line saying where searches go, and whether added NZBs can still be downloaded when Usenet search is off.
function usenetSources(usenet: NonNullable<TomifinServiceStatus['downloaders']>['usenet']) {
  if (!usenet.available) return `Searching torrents only. Usenet is not available${usenet.problem ? `: ${usenet.problem}` : '.'}`
  if (usenet.search && !usenet.search.available) return 'Searching torrents only. Usenet search is off, but added NZB links and files still download with SABnzbd.'
  const providers = usenet.search?.providers?.length ? ` (${usenet.search.providers.join(', ')})` : ''
  return `Searching torrents and Usenet${providers}.`
}

const VPN_POLL_MS = 30_000

// The VPN qBittorrent downloads through, as one line in the toolbar.
function VpnStatus({ vpn }: { vpn: TomifinVpnStatus }) {
  const place = [vpn.nordvpn?.city, vpn.nordvpn?.country].filter(Boolean).join(', ')
  const [tone, Icon, label] = vpn.state === 'connected' ? ['ok', ShieldCheck, `VPN connected${place ? ` · ${place}` : ''}`] as const
    : vpn.state === 'connecting' ? ['warn', ShieldQuestion, 'VPN connecting…'] as const
    : vpn.state === 'down' ? ['bad', ShieldAlert, 'VPN down: downloads and searches are paused'] as const
    : ['warn', ShieldQuestion, 'VPN status unknown'] as const
  return <span className={`tf-vpn tf-vpn-${tone}`} title={vpn.nordvpn?.server ? `NordVPN server ${vpn.nordvpn.server}` : `qBittorrent: ${vpn.qbittorrent}`}><Icon aria-hidden/>{label}</span>
}

function Downloader({ user, onSignOut, onExpired }: { user: TomifinUser; onSignOut: () => void; onExpired: () => void }) {
  const [status, setStatus] = useState<TomifinServiceStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [destination, setDestination] = useState<TomifinDestination | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<TomifinKind>('video')
  const [searched, setSearched] = useState<{ query: string; results: TomifinResult[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('relevance')
  const [resolution, setResolution] = useState<'any' | typeof RESOLUTIONS[number]>('any')
  const [minSeeders, setMinSeeders] = useState(1)
  const [typeFilter, setTypeFilter] = useState<'any' | 'torrent' | 'usenet'>('any')
  const [warnings, setWarnings] = useState<string[]>([])
  const [queuing, setQueuing] = useState<string | null>(null)
  const [queued, setQueued] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null)
  const [jobs, setJobs] = useState<TomifinJob[] | null>(null)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [vpn, setVpn] = useState<TomifinVpnStatus | null>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const destinationRef = useRef<HTMLDivElement | null>(null)
  // A session Jellyfin no longer accepts goes back to the sign-in form; other errors are shown where they happened.
  const failed = useCallback((error: unknown) => { if (error instanceof TomifinRequestError && (error.status === 401 || error.status === 403)) { onExpired(); return true } return false }, [onExpired])

  useEffect(() => {
    const controller = new AbortController()
    tomifinApi.status(controller.signal).then(setStatus, (error) => { if (!controller.signal.aborted && !failed(error)) setStatusError(message(error)) })
    return () => controller.abort()
  }, [failed])

  useEffect(() => {
    if (status && !status.available) return
    const controller = new AbortController()
    // An agent too old to report it (or any other failure) just hides the VPN line.
    const load = () => tomifinApi.vpn(controller.signal).then(setVpn, (error) => { if (!controller.signal.aborted && !failed(error)) setVpn(null) })
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, VPN_POLL_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [failed, status])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setJobsLoading(true)
    try { const { jobs: next } = await tomifinApi.downloads(signal); setJobs(next); setJobsError(null) }
    catch (error) { if (!signal?.aborted && !failed(error)) setJobsError(message(error)) }
    finally { if (!signal?.aborted) setJobsLoading(false) }
  }, [failed])

  const active = Boolean(jobs?.some((job) => ['queued', 'downloading', 'stalled'].includes(job.status)))
  useEffect(() => {
    if (status && !status.available) return
    const controller = new AbortController()
    void refresh(controller.signal)
    // Polls quickly while something is downloading and slowly otherwise; never while the tab is hidden.
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(controller.signal) }, active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh, active, status])

  const runSearch = async () => {
    const trimmed = query.trim()
    if (trimmed.length < 2) { setSearchError('Type at least two characters to search.'); return }
    searchAbort.current?.abort()
    const controller = new AbortController()
    searchAbort.current = controller
    setSearching(true); setSearchError(null); setNotice(null)
    try {
      const response = await tomifinApi.search(trimmed, kind, controller.signal)
      setSearched({ query: response.query, results: response.results }); setQueued(new Set()); setWarnings(response.warnings || [])
    } catch (error) {
      if (!controller.signal.aborted && !failed(error)) setSearchError(message(error))
    } finally { if (searchAbort.current === controller) setSearching(false) }
  }

  const queue = async (result: TomifinResult) => {
    if (!destination) { needDestination(); return false }
    setQueuing(result.id); setNotice(null)
    try {
      const { job } = await tomifinApi.download(result.id, destination)
      setQueued((current) => new Set(current).add(result.id))
      setNotice({ tone: 'success', text: `Queued in ${result.type === 'usenet' ? 'SABnzbd' : 'qBittorrent'}: “${result.title}” → ${DESTINATIONS[job.destination].label} (${DESTINATIONS[job.destination].path}).` })
      void refresh()
      return true
    } catch (error) {
      if (failed(error)) return false
      setNotice({ tone: 'error', text: error instanceof TomifinRequestError && error.code === 'result-expired' ? 'That result has expired. Search again, then queue it.' : `Could not queue “${result.title}”: ${message(error)}` })
      return false
    } finally { setQueuing(null) }
  }

  const needDestination = () => {
    setNotice({ tone: 'warn', text: 'Choose Family or Private before queuing a download.' })
    destinationRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }

  const control = async (job: TomifinJob, action: TomifinJobAction) => {
    setBusyJob(job.id)
    try {
      const response = await tomifinApi.control(job.id, action)
      if (action === 'retry') setNotice({ tone: 'success', text: `Retrying “${job.name}” in ${job.downloaderLabel || 'qBittorrent'}.` })
      if (action === 'cancel') setNotice({ tone: 'success', text: response.filesDeleted ? `Cancelled “${job.name}” and deleted its partial download.` : `Removed “${job.name}” from ${job.downloaderLabel || 'qBittorrent'}. Its files were kept.` })
      await refresh()
    } catch (error) { if (!failed(error)) setNotice({ tone: 'error', text: message(error) }) }
    finally { setBusyJob(null) }
  }

  const visible = useMemo(() => {
    if (!searched) return []
    // The seeders filter applies to torrents only: NZBs have no seeders.
    const filtered = searched.results.filter((result) => (result.type !== 'torrent' || (result.seeders ?? 0) >= minSeeders) && (typeFilter === 'any' || result.type === typeFilter) && (resolution === 'any' || result.quality.resolution === resolution))
    return sortResults(filtered, sort, searched.query)
  }, [searched, sort, resolution, minSeeders, typeFilter])
  const usenetStatus = status?.downloaders?.usenet

  const unavailable = status && !status.available

  return (
    <>
      <div className="tf-toolbar-user">
        {vpn && <VpnStatus vpn={vpn}/>}
        <span className="tf-muted">Signed in as <strong>{user.name}</strong></span>
        <button type="button" className="tf-link" onClick={onSignOut}><LogOut aria-hidden/>Sign out</button>
      </div>
      {statusError && <div className="tf-alert tf-alert-error" role="alert"><TriangleAlert aria-hidden/>{statusError}</div>}
      {unavailable && <div className="tf-alert tf-alert-warn" role="alert"><TriangleAlert aria-hidden/>Tomifin Downloader is not available: {status.problem || 'the media server is not set up for it.'}</div>}

      <section className="tf-panel tf-search-panel" aria-labelledby="tf-search-title">
        <h2 id="tf-search-title" className="tf-visually-hidden">Search</h2>
        <form className="tf-search" role="search" onSubmit={(event) => { event.preventDefault(); void runSearch() }}>
          <div className="tf-input tf-search-input"><Search aria-hidden/><input type="search" placeholder="Search films and TV…" aria-label="Search for media" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} enterKeyHint="search"/></div>
          <button className="tf-button tf-primary tf-search-button" disabled={searching || Boolean(unavailable)}>{searching ? <><LoaderCircle className="tf-spin" aria-hidden/>Searching…</> : <><Search aria-hidden/>Search</>}</button>
        </form>
        <div className="tf-segments" role="radiogroup" aria-label="What to search">
          {KINDS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={kind === entry.id} className={kind === entry.id ? 'tf-segment tf-segment-on' : 'tf-segment'} onClick={() => setKind(entry.id)}>{entry.label}</button>)}
        </div>
        {usenetStatus && <p className="tf-sources tf-muted">{usenetSources(usenetStatus)}</p>}
      </section>

      <div ref={destinationRef}><DestinationPicker value={destination} onChange={(value) => { setDestination(value); setNotice(null) }} status={status}/></div>

      <AddLink destination={destination} disabled={Boolean(unavailable)} needDestination={needDestination} onChecked={() => setNotice(null)} onQueue={(result) => queue(result)}/>

      {notice && <div className={`tf-alert tf-alert-${notice.tone}`} role={notice.tone === 'success' ? 'status' : 'alert'}>{notice.tone === 'success' ? <CircleCheck aria-hidden/> : <TriangleAlert aria-hidden/>}{notice.text}</div>}

      <section className="tf-panel" aria-labelledby="tf-results-title" aria-busy={searching}>
        <div className="tf-section-head">
          <h2 id="tf-results-title">Results</h2>
          {searched && <span className="tf-muted">{visible.length} of {searched.results.length} result{searched.results.length === 1 ? '' : 's'} for “{searched.query}”</span>}
        </div>
        {searched && searched.results.length > 0 && (
          <div className="tf-filters">
            <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="relevance">Relevance</option><option value="seeders">Most seeders</option><option value="size-desc">Largest first</option><option value="size-asc">Smallest first</option></select></label>
            <label><span>Quality</span><select value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}><option value="any">Any</option>{RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label><span>Seeders</span><select value={minSeeders} onChange={(event) => setMinSeeders(Number(event.target.value))}><option value={1}>Any</option><option value={5}>5+</option><option value={20}>20+</option><option value={100}>100+</option></select></label>
            <label><span>Type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}><option value="any">All</option><option value="torrent">Torrent</option><option value="usenet">Usenet</option></select></label>
          </div>
        )}
        {warnings.map((warning) => <div key={warning} className="tf-alert tf-alert-warn" role="status"><TriangleAlert aria-hidden/>{warning}</div>)}
        {searchError && <div className="tf-alert tf-alert-error" role="alert"><TriangleAlert aria-hidden/>{searchError}</div>}
        {searching && <ul className="tf-results" aria-hidden>{[0, 1, 2].map((index) => <li key={index} className="tf-result tf-skeleton"/>)}</ul>}
        {!searching && !searched && !searchError && <p className="tf-empty"><Clapperboard aria-hidden/>Search for a film or series to see torrents and NZBs from Tomify’s sources.</p>}
        {!searching && searched && searched.results.length === 0 && <p className="tf-empty">Nothing found for “{searched.query}”. Try a shorter title or add the year.</p>}
        {!searching && searched && searched.results.length > 0 && visible.length === 0 && <p className="tf-empty">No results match these filters.</p>}
        {!searching && visible.length > 0 && <ul className="tf-results">{visible.map((result) => <ResultCard key={result.id} result={result} destination={destination} busy={queuing === result.id} queued={queued.has(result.id)} onQueue={(value) => { void queue(value) }}/>)}</ul>}
      </section>

      {!unavailable && <Downloads jobs={jobs} loading={jobsLoading} error={jobsError} onRefresh={() => void refresh()} onAction={(job, action) => void control(job, action)} busyId={busyJob}/>}
    </>
  )
}

export function TomifinApp() {
  // undefined while the saved session is being checked, null when signed out.
  const [user, setUser] = useState<TomifinUser | null | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    tomifinApi.session(controller.signal).then(({ user: current }) => setUser(current), () => { if (!controller.signal.aborted) setUser(null) })
    return () => controller.abort()
  }, [])
  const signOut = () => { void tomifinApi.signOut().catch(() => undefined); setUser(null) }
  return (
    <div className="tf-app">
      <header className="tf-header">
        <img src="/tomify-logo-192.png" alt="" className="tf-logo" width={40} height={40}/>
        <h1>TOMIFIN <span>DOWNLOADER</span></h1>
      </header>
      <main className="tf-main">
        {user === undefined && <p className="tf-empty"><LoaderCircle className="tf-spin" aria-hidden/>Checking your sign-in…</p>}
        {user === null && <SignIn onSignedIn={setUser}/>}
        {user && <Downloader user={user} onSignOut={signOut} onExpired={() => setUser(null)}/>}
      </main>
    </div>
  )
}
