import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Ban, ChevronDown, Headphones, ListPlus, ListVideo, LoaderCircle, LogOut, Maximize, MoreVertical, Pause, Play, RefreshCw, Search, Settings, SkipBack, SkipForward, Trash2, Tv, Upload, X } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { DEFAULT_NAVIDROME_SERVER } from '../lib/navidrome'
import { mediaTokenStatus, onMediaTokenChange, startMediaTokens } from './mediaToken'
import { formatDuration, formatViews, thumbnailUrl, tomtubeApi, TomTubeError, youtubeLinkId, type Recommendations, type RecommendedVideo, type TomTubeVideo, type TrainingStatus } from './api'
import { TomTubeEngine } from './engine'
import * as Q from './queue'
import { useTomTube } from './store'

const useMediaTokenStatus = () => useSyncExternalStore(onMediaTokenChange, mediaTokenStatus)

function SignIn() {
  const login = useAuth((state) => state.login)
  const status = useAuth((state) => state.status)
  const error = useAuth((state) => state.error)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return <main className="tt-signin">
    <form onSubmit={(event) => { event.preventDefault(); void login(DEFAULT_NAVIDROME_SERVER, username, password).catch(() => undefined) }}>
      <Logo large/>
      <p>Sign in with your Tomify account.</p>
      <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" required/></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required/></label>
      {error && <div className="tt-error" role="alert">{error}</div>}
      <button className="tt-primary" disabled={status === 'checking'}>{status === 'checking' ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </main>
}

function Logo({ large = false }: { large?: boolean }) {
  return <span className={`tt-logo${large ? ' large' : ''}`}><span className="tt-logo-mark"><Play fill="currentColor"/></span>TomTube</span>
}

function Thumb({ id, duration, variant = 'mqdefault' }: { id: string; duration?: number | null; variant?: 'mqdefault' | 'hqdefault' }) {
  const session = useAuth((state) => state.session)!
  useMediaTokenStatus()
  const src = thumbnailUrl(session, id, variant)
  return <span className="tt-thumb">
    {src && <img src={src} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.style.visibility = 'hidden' }}/>}
    {duration ? <span className="tt-badge">{formatDuration(duration)}</span> : null}
  </span>
}

interface RowActions { onPlay(): void; onPlayNext?(): void; onQueue?(): void; onRemove?(): void; onNotInterested?(): void }

function VideoRow({ video, actions, active = false, compact = false, note }: { video: TomTubeVideo; actions: RowActions; active?: boolean; compact?: boolean; note?: string }) {
  const [menu, setMenu] = useState(false)
  return <li className={`tt-row${compact ? ' compact' : ''}${active ? ' active' : ''}`}>
    <button className="tt-row-main" onClick={actions.onPlay}>
      <Thumb id={video.id} duration={video.duration}/>
      <span className="tt-row-text">
        <span className="tt-title">{video.title}</span>
        <span className="tt-meta">{[video.channel, formatViews(video.viewCount)].filter(Boolean).join(' · ')}</span>
        {note && <span className="tt-meta tt-reason">{note}</span>}
      </span>
    </button>
    {(actions.onPlayNext || actions.onQueue || actions.onRemove || actions.onNotInterested) && <button className="tt-icon" aria-label="More" title="More" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreVertical/></button>}
    {menu && <div className="tt-menu" onClick={() => setMenu(false)}>
      {actions.onPlayNext && <button onClick={actions.onPlayNext}><ListVideo/>Play next</button>}
      {actions.onQueue && <button onClick={actions.onQueue}><ListPlus/>Add to queue</button>}
      {actions.onRemove && <button onClick={actions.onRemove}><Trash2/>Remove</button>}
      {actions.onNotInterested && <button onClick={actions.onNotInterested}><Ban/>Not interested</button>}
    </div>}
  </li>
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="tt-section"><header><h2>{title}</h2>{action}</header>{children}</section>
}

const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null

function cookieSummary(status: TrainingStatus) {
  const { cookies } = status
  if (status.youtubeAccount === false && cookies.state === 'missing') return 'Your suggestions are your own: TomTube learns from what you watch here on this account.'
  switch (cookies.state) {
    case 'missing': return 'No YouTube cookies yet. TomTube learns from what you watch here; add cookies to learn from your YouTube recommendations, subscriptions and history too.'
    case 'checking': return 'Checking your cookies with YouTube…'
    case 'valid': return [`Cookies work. Last synced ${when(cookies.lastSuccessAt) || 'just now'}.`, cookies.nextSyncAt && `Next sync ${when(cookies.nextSyncAt)}.`, cookies.expiresAt && `The sign-in expires ${when(cookies.expiresAt)} at the latest.`].filter(Boolean).join(' ')
    case 'expired': return `Cookies expired${cookies.lastError?.at ? ` (${when(cookies.lastError.at)})` : ''}. Suggestions now come from what TomTube has learned. Add new cookies below to keep learning from YouTube.`
    default: return `The last sync failed${cookies.lastError ? `: ${cookies.lastError.message}` : '.'}`
  }
}

// The training period: cookie status, adding or renewing cookies, and forgetting what was learned.
// The cookie text is sent once and never kept in the app.
function TrainingSettings({ onChanged }: { onChanged(): void }) {
  const session = useAuth((state) => state.session)!
  const [status, setStatus] = useState<TrainingStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cookies, setCookies] = useState('')
  const [adding, setAdding] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const run = async (task: () => Promise<TrainingStatus>) => {
    setBusy(true)
    setError(null)
    try { setStatus(await task()); onChanged() } catch (failure) { setError(failure instanceof Error ? failure.message : 'That did not work.') } finally { setBusy(false) }
  }

  useEffect(() => { void run(() => tomtubeApi.training(session)) }, [session])
  // While the server checks new cookies, look again every few seconds.
  useEffect(() => {
    if (status?.cookies.state !== 'checking') return
    const timer = window.setTimeout(() => { void tomtubeApi.training(session).then((next) => { setStatus(next); if (next.cookies.state !== 'checking') onChanged() }).catch(() => undefined) }, 3000)
    return () => window.clearTimeout(timer)
  }, [status, session])

  const save = async (text: string) => {
    if (!text.trim()) return
    await run(() => tomtubeApi.uploadCookies(session, text))
    setCookies('')
    if (fileRef.current) fileRef.current.value = ''
    setAdding(false)
  }

  const learned = status?.learned
  return <section className="tt-group" aria-label="Recommendations">
    <h3>Recommendations</h3>
    {status ? <p className="tt-note" role="status">{cookieSummary(status)}</p> : !error && <p className="tt-note">Loading…</p>}
    {learned && <p className="tt-note">Learned so far: {learned.watches} watched in TomTube ({learned.finished} finished, {learned.skipped} skipped), {learned.notInterested} marked Not interested, {learned.youtubeHistory} from your YouTube history, {learned.subscriptions} subscribed channels. What YouTube recommends is only used to discover channels, never counted as something you like.</p>}
    {error && <div className="tt-error" role="alert">{error}</div>}
    {status?.youtubeAccount === false ? null : adding ? <div className="tt-cookies">
      <ol className="tt-note">
        <li>On a computer, open a private (incognito) window and sign in to youtube.com.</li>
        <li>Export the cookies for youtube.com as <b>cookies.txt</b>, for example with the “Get cookies.txt LOCALLY” extension.</li>
        <li>Close the private window (so the browser doesn't change them), then upload or paste the file here.</li>
      </ol>
      <p className="tt-note">They are stored encrypted on your Tomify server, used only to read your history, subscriptions and recommendations a few times a day (never to play videos), and never shown again here. Renewing them keeps everything TomTube has learned.</p>
      <label className="tt-secondary tt-file"><Upload/>Upload cookies.txt<input ref={fileRef} type="file" accept=".txt,.json,text/plain,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(save) }}/></label>
      <textarea value={cookies} onChange={(event) => setCookies(event.target.value)} placeholder="…or paste the contents of cookies.txt" aria-label="Paste cookies.txt" autoCapitalize="none" autoCorrect="off" spellCheck={false} rows={4}/>
      <button className="tt-primary" disabled={busy || !cookies.trim()} onClick={() => void save(cookies)}>Save cookies</button>
      <button className="tt-secondary" onClick={() => { setAdding(false); setCookies('') }}>Cancel</button>
    </div> : <button className="tt-secondary" disabled={busy} onClick={() => setAdding(true)}>{status?.cookies.state === 'missing' ? 'Add YouTube cookies' : 'Renew YouTube cookies'}</button>}
    {status && status.youtubeAccount !== false && status.cookies.state !== 'missing' && <>
      <button className="tt-secondary" disabled={busy || status.cookies.state === 'checking'} onClick={() => void run(() => tomtubeApi.syncTraining(session))}><RefreshCw/>Sync now</button>
      <button className="tt-secondary" disabled={busy} onClick={() => { if (window.confirm('Remove your YouTube cookies from the server? What TomTube has learned is kept.')) void run(() => tomtubeApi.removeCookies(session)) }}>Remove cookies</button>
    </>}
    <button className="tt-secondary" disabled={busy} onClick={() => { if (window.confirm(status?.youtubeAccount === false ? 'Forget everything TomTube has learned about what you watch?' : 'Forget everything TomTube has learned about what you watch? Your cookies are kept.')) void run(() => tomtubeApi.clearTraining(session)) }}><Trash2/>Clear training data</button>
  </section>
}

function SettingsSheet({ onClose, engine, onTrainingChanged }: { onClose(): void; engine: TomTubeEngine | null; onTrainingChanged(): void }) {
  const settings = useTomTube((state) => state.settings)
  const setSettings = useTomTube((state) => state.setSettings)
  const logout = useAuth((state) => state.logout)
  const session = useAuth((state) => state.session)!
  const [status, setStatus] = useState<string | null>(null)
  const change = (value: Parameters<typeof setSettings>[0]) => { setSettings(value); engine?.settingsChanged() }
  const checkServer = async () => {
    setStatus('Checking…')
    try {
      const body = await tomtubeApi.status(session) as { ytdlp?: { version?: string }; failures?: { recent?: Array<{ code: string; message: string; at: string }> } }
      const last = body.failures?.recent?.[0]
      setStatus(`yt-dlp ${body.ytdlp?.version || 'not found'}.${last ? ` Last failure: ${last.code} (${new Date(last.at).toLocaleString()}): ${last.message}` : ' No recent failures.'}`)
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not check the server.') }
  }
  return <div className="tt-sheet" role="dialog" aria-label="Settings">
    <header><h2>Settings</h2><button className="tt-icon" aria-label="Close" title="Close" onClick={onClose}><X/></button></header>
    <label className="tt-toggle"><input type="checkbox" checked={settings.backgroundAudio} onChange={(event) => change({ backgroundAudio: event.target.checked })}/><span><b>Keep listening when the phone locks</b>Switches a playing video to audio when TomTube goes to the background, and back when you return.</span></label>
    <label className="tt-toggle"><input type="checkbox" checked={settings.continuousQueue} onChange={(event) => change({ continuousQueue: event.target.checked })}/><span><b>Continuous queue (experimental)</b>In audio mode, plays the queue as one stream from Tomify so the next video starts even if iOS won't let a locked web app start it.</span></label>
    <label className="tt-select"><span><b>Video quality</b></span><select value={settings.videoQuality} onChange={(event) => change({ videoQuality: event.target.value as 'auto' | 'compatible' })}><option value="auto">Automatic (up to 1080p)</option><option value="compatible">Compatible (360p single file)</option></select></label>
    <label className="tt-select"><span><b>Audio stream</b></span><select value={settings.audioFormat} onChange={(event) => change({ audioFormat: event.target.value as 'auto' | 'hls' | 'file' })}><option value="auto">Automatic (M4A on iPhone and iPad)</option><option value="hls">HLS</option><option value="file">Single file (M4A)</option></select></label>
    <button className="tt-secondary" onClick={() => void checkServer()}>Check server</button>
    {status && <p className="tt-note">{status}</p>}
    <TrainingSettings onChanged={onTrainingChanged}/>
    <button className="tt-secondary" onClick={() => { useTomTube.getState().clearHistory() }}>Clear recently watched</button>
    <button className="tt-secondary" onClick={logout}><LogOut/>Sign out of {session.username}</button>
  </div>
}

function Controls({ engine }: { engine: TomTubeEngine }) {
  const player = useTomTube((state) => state.player)
  const queue = useTomTube((state) => state.queue)
  const [scrub, setScrub] = useState<number | null>(null)
  const duration = player.duration || Q.current(queue)?.duration || 0
  const time = scrub ?? player.currentTime
  const busy = player.status === 'loading' || player.status === 'buffering'
  return <div className="tt-controls">
    <input className="tt-seek" type="range" min={0} max={Math.max(1, duration)} step={1} value={Math.min(time, duration || time)} aria-label="Seek"
      onChange={(event) => setScrub(Number(event.target.value))}
      onPointerUp={() => { if (scrub !== null) { engine.seek(scrub); setScrub(null) } }}
      onKeyUp={() => { if (scrub !== null) { engine.seek(scrub); setScrub(null) } }}
      onTouchEnd={() => { if (scrub !== null) { engine.seek(scrub); setScrub(null) } }}/>
    <div className="tt-times"><span>{formatDuration(time) || '0:00'}</span><span>{formatDuration(duration)}</span></div>
    <div className="tt-buttons">
      <button className="tt-icon" aria-label="Previous" title="Previous" onClick={() => engine.skipPrevious()}><SkipBack/></button>
      <button className="tt-icon" aria-label="Back 10 seconds" title="Back 10 seconds" onClick={() => engine.seek(player.currentTime - 10)}><span className="tt-skip">-10</span></button>
      <button className="tt-play" aria-label={player.playing ? 'Pause' : 'Play'} title={player.playing ? 'Pause' : 'Play'} onClick={() => engine.toggle()}>{busy && player.playing ? <LoaderCircle className="tt-spin"/> : player.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button>
      <button className="tt-icon" aria-label="Forward 10 seconds" title="Forward 10 seconds" onClick={() => engine.seek(player.currentTime + 10)}><span className="tt-skip">+10</span></button>
      <button className="tt-icon" aria-label="Next" title="Next" disabled={!Q.next(queue)} onClick={() => engine.skipNext()}><SkipForward/></button>
    </div>
    <div className="tt-modes" role="radiogroup" aria-label="Playback mode">
      <button role="radio" aria-checked={player.mode === 'video'} className={player.mode === 'video' ? 'on' : ''} onClick={() => engine.setMode('video')}><Tv/>Video</button>
      <button role="radio" aria-checked={player.mode === 'audio'} className={player.mode === 'audio' ? 'on' : ''} onClick={() => engine.setMode('audio')}><Headphones/>Audio only</button>
    </div>
    {player.error && <div className="tt-error" role="alert">{player.error}</div>}
  </div>
}

const SHELF_SIZE = 8

function Shelves({ data, loading, error, onRefresh, onOpenSettings, actions }: { data: Recommendations | null; loading: boolean; error: string | null; onRefresh(): void; onOpenSettings(): void; actions(video: TomTubeVideo): RowActions }) {
  const session = useAuth((state) => state.session)!
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // Hidden at once; the server stops suggesting the video and counts it against its channel.
  const [rejected, setRejected] = useState<Set<string>>(() => new Set())
  const notInterested = (video: TomTubeVideo) => {
    setRejected((current) => new Set(current).add(video.id))
    void tomtubeApi.notInterested(session, video).catch(() => undefined)
  }
  const refresh = <button className="tt-link" onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
  if (!data?.shelves.length) {
    if (!data && !error && !loading) return null
    return <Section title="Recommended" action={refresh}>
      {error ? <p className="tt-note">{error}</p>
        : loading ? <p className="tt-note">Finding videos for you…</p>
        : data?.cookies === 'missing' ? <p className="tt-note">Recommendations appear as TomTube learns what you watch. To start with your YouTube recommendations, <button className="tt-link" onClick={onOpenSettings}>add your YouTube cookies in Settings</button>.</p>
        : <p className="tt-note">Nothing to suggest yet. Watch a few videos and come back.</p>}
    </Section>
  }
  return <>{data.shelves.map((shelf, index) => {
    const remaining = shelf.videos.filter((video) => !rejected.has(video.id))
    if (!remaining.length) return null
    const videos: RecommendedVideo[] = open[shelf.id] ? remaining : remaining.slice(0, SHELF_SIZE)
    return <Section key={shelf.id} title={shelf.title} action={index === 0 ? refresh : undefined}>
      {index === 0 && data.cookies === 'expired' && <p className="tt-note">Your YouTube cookies have expired, so these come from what TomTube has learned. <button className="tt-link" onClick={onOpenSettings}>Renew them</button></p>}
      <ul className="tt-list">{videos.map((video) => <VideoRow key={video.id} video={video} note={shelf.id === 'youtube' ? undefined : video.reason} actions={{ ...actions(video), onNotInterested: () => notInterested(video) }}/>)}</ul>
      {remaining.length > SHELF_SIZE && <button className="tt-link tt-more" onClick={() => setOpen({ ...open, [shelf.id]: !open[shelf.id] })}>{open[shelf.id] ? 'Show fewer' : `Show ${remaining.length - SHELF_SIZE} more`}</button>}
    </Section>
  })}</>
}

function useRecommendations() {
  const session = useAuth((state) => state.session)!
  const [data, setData] = useState<Recommendations | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const load = async (refresh = false) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true)
    setError(null)
    try { setData(await tomtubeApi.recommendations(session, refresh, controller.signal)) }
    catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return
      // A server without the recommendations update says nothing rather than showing an error.
      if (failure instanceof TomTubeError && (failure.status === 404 || failure.code === 'training-disabled')) setData(null)
      else setError(failure instanceof Error ? failure.message : 'Recommendations could not be loaded.')
    } finally { if (abort.current === controller) setLoading(false) }
  }
  useEffect(() => { void load(); return () => abort.current?.abort() }, [session])
  return { data, loading, error, load }
}

export function TomTubeApp() {
  const session = useAuth((state) => state.session)
  const status = useAuth((state) => state.status)
  if (!session || status === 'signed-out') return <SignIn/>
  return <TomTube/>
}

function TomTube() {
  const session = useAuth((state) => state.session)!
  const queue = useTomTube((state) => state.queue)
  const history = useTomTube((state) => state.history)
  const player = useTomTube((state) => state.player)
  const expanded = useTomTube((state) => state.expanded)
  const setExpanded = useTomTube((state) => state.setExpanded)
  const setQueue = useTomTube((state) => state.setQueue)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [engine, setEngine] = useState<TomTubeEngine | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TomTubeVideo[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const searchAbort = useRef<AbortController | null>(null)
  const current = Q.current(queue)
  const recommendations = useRecommendations()

  const tokenStatus = useMediaTokenStatus()
  useEffect(() => startMediaTokens({ username: session.username, token: session.token, salt: session.salt }), [session])

  useEffect(() => {
    const created = new TomTubeEngine({ video: videoRef.current!, audio: audioRef.current!, session: () => useAuth.getState().session, api: tomtubeApi, mediaSession: 'mediaSession' in navigator ? navigator.mediaSession : null })
    setEngine(created)
    // A reload shows the last video ready to play from where it was, without starting it.
    const state = useTomTube.getState()
    const last = Q.current(state.queue)
    if (last) state.setPlayer({ status: 'paused', playing: false, currentTime: state.history.find((entry) => entry.id === last.id)?.position ?? 0 })
    return () => created.destroy()
  }, [])

  const updateQueue = (next: Q.QueueState) => { setQueue(next); engine?.queueChanged() }

  const open = (video: TomTubeVideo) => {
    if (!engine) return
    const saved = history.find((entry) => entry.id === video.id)
    engine.playVideo(video, Q.resumePosition(saved, video.duration))
    setExpanded(true)
  }

  const search = async (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) return
    searchAbort.current?.abort()
    const controller = new AbortController()
    searchAbort.current = controller
    setSearching(true)
    setError(null)
    try {
      const linked = youtubeLinkId(text)
      if (linked) {
        // A pasted link opens that video. iOS may not start it after the network wait; the play button does.
        const details = await tomtubeApi.resolve(session, text, controller.signal)
        setResults([details])
        open(details)
      } else {
        setResults((await tomtubeApi.search(session, text, controller.signal)).results)
      }
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return
      setError(failure instanceof TomTubeError || failure instanceof Error ? failure.message : 'Search failed.')
    } finally { if (searchAbort.current === controller) setSearching(false) }
  }

  const rowActions = (video: TomTubeVideo): RowActions => ({
    onPlay: () => open(video),
    onPlayNext: () => updateQueue(Q.playNext(queue, video)),
    onQueue: () => updateQueue(Q.addToQueue(queue, video)),
  })

  const upNext = useMemo(() => queue.items.map((video, index) => ({ video, index })).filter(({ index }) => index > queue.index), [queue])

  return <div className={`tt-app${current ? ' has-player' : ''}${expanded && current ? ' player-open' : ''}`}>
    <header className="tt-top">
      <button className="tt-home" onClick={() => { setResults(null); setQuery(''); setError(null) }} aria-label="Home"><Logo/></button>
      <form className="tt-search" onSubmit={(event) => void search(event)} role="search">
        <input type="search" enterKeyHint="search" placeholder="Search or paste a YouTube link" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search YouTube"/>
        <button aria-label="Search" title="Search" disabled={searching}>{searching ? <LoaderCircle className="tt-spin"/> : <Search/>}</button>
      </form>
      <button className="tt-icon" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><Settings/></button>
    </header>

    <main className="tt-main">
      {tokenStatus === 'not-configured' && <div className="tt-error" role="alert">TomTube needs secure media links (TOMIFY_MEDIA_KEY), which are not set up on the Tomify server yet, so videos can't play.</div>}
      {error && <div className="tt-error" role="alert">{error}</div>}
      {results ? <Section title={`Results for “${query.trim()}”`}>
        {results.length ? <ul className="tt-list">{results.map((video) => <VideoRow key={video.id} video={video} actions={rowActions(video)}/>)}</ul> : <p className="tt-note">Nothing found.</p>}
      </Section> : <>
        {upNext.length > 0 && <Section title="Up next" action={<button className="tt-link" onClick={() => updateQueue(Q.clearUpcoming(queue))}>Clear</button>}>
          <ul className="tt-list">{upNext.map(({ video, index }) => <VideoRow key={`${video.id}-${index}`} compact video={video} actions={{ onPlay: () => engine?.playAt(index), onRemove: () => updateQueue(Q.removeAt(queue, index)) }}/>)}</ul>
        </Section>}
        <Shelves data={recommendations.data} loading={recommendations.loading} error={recommendations.error} onRefresh={() => void recommendations.load(true)} onOpenSettings={() => setSettingsOpen(true)} actions={rowActions}/>
        <Section title="Recently watched" action={history.length ? <span className="tt-meta">{history.length}</span> : undefined}>
          {history.length ? <ul className="tt-list">{history.slice(0, 50).map((video) => <VideoRow key={video.id} video={video} actions={rowActions(video)}/>)}</ul>
            : <p className="tt-note">Search for a video or paste a YouTube link to start. Videos play from your Tomify server, without adverts, and keep playing as audio when your phone locks.</p>}
        </Section>
      </>}
    </main>

    <section className={`tt-player${expanded ? ' open' : ''}${current ? '' : ' empty'}`} aria-label="Player">
      <div className={`tt-stage ${player.mode}`} onClick={() => { if (!expanded && current) setExpanded(true) }}>
        <video ref={videoRef} playsInline preload="metadata" x-webkit-airplay="allow"/>
        {current && player.mode === 'audio' && <div className="tt-audio-art"><Thumb id={current.id} variant="hqdefault"/><span className="tt-audio-label"><Headphones/>Audio only</span></div>}
      </div>
      {current && !expanded && <div className="tt-mini" onClick={() => setExpanded(true)}>
        <span className="tt-row-text"><span className="tt-title">{current.title}</span><span className="tt-meta">{current.channel}{player.mode === 'audio' ? ' · Audio' : ''}</span></span>
        <button className="tt-icon" aria-label={player.playing ? 'Pause' : 'Play'} title={player.playing ? 'Pause' : 'Play'} onClick={(event) => { event.stopPropagation(); engine?.toggle() }}>{player.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button>
        <button className="tt-icon" aria-label="Next" title="Next" disabled={!Q.next(queue)} onClick={(event) => { event.stopPropagation(); engine?.skipNext() }}><SkipForward/></button>
      </div>}
      {current && expanded && engine && <div className="tt-details">
        <div className="tt-details-head">
          <button className="tt-icon" aria-label="Minimise player" title="Minimise player" onClick={() => setExpanded(false)}><ChevronDown/></button>
          {player.mode === 'video' && <button className="tt-icon" aria-label="Full screen" title="Full screen" onClick={() => { const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (video?.requestFullscreen) void video.requestFullscreen().catch(() => video.webkitEnterFullscreen?.()); else video?.webkitEnterFullscreen?.() }}><Maximize/></button>}
        </div>
        <h1 className="tt-now-title">{current.title}</h1>
        <p className="tt-meta">{[current.channel, formatViews(current.viewCount)].filter(Boolean).join(' · ')}</p>
        <Controls engine={engine}/>
        {upNext.length > 0 && <Section title="Up next">
          <ul className="tt-list">{upNext.map(({ video, index }) => <VideoRow key={`${video.id}-${index}`} compact video={video} actions={{ onPlay: () => engine.playAt(index), onRemove: () => updateQueue(Q.removeAt(queue, index)) }}/>)}</ul>
        </Section>}
      </div>}
      <audio ref={audioRef} preload="auto" x-webkit-airplay="allow"/>
    </section>

    {settingsOpen && <SettingsSheet engine={engine} onClose={() => setSettingsOpen(false)} onTrainingChanged={() => void recommendations.load(true)}/>}
  </div>
}
