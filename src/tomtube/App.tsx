import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronDown, Headphones, ListPlus, ListVideo, LoaderCircle, LogOut, Maximize, MoreVertical, Pause, Play, Search, Settings, SkipBack, SkipForward, Trash2, Tv, X } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { DEFAULT_NAVIDROME_SERVER } from '../lib/navidrome'
import { startMediaRoute } from '../lib/mediaRoute'
import { formatDuration, formatViews, thumbnailUrl, tomtubeApi, TomTubeError, youtubeLinkId, type TomTubeVideo } from './api'
import { TomTubeEngine } from './engine'
import * as Q from './queue'
import { useTomTube } from './store'

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
  return <span className="tt-thumb">
    <img src={thumbnailUrl(session, id, variant)} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.style.visibility = 'hidden' }}/>
    {duration ? <span className="tt-badge">{formatDuration(duration)}</span> : null}
  </span>
}

interface RowActions { onPlay(): void; onPlayNext?(): void; onQueue?(): void; onRemove?(): void }

function VideoRow({ video, actions, active = false, compact = false }: { video: TomTubeVideo; actions: RowActions; active?: boolean; compact?: boolean }) {
  const [menu, setMenu] = useState(false)
  return <li className={`tt-row${compact ? ' compact' : ''}${active ? ' active' : ''}`}>
    <button className="tt-row-main" onClick={actions.onPlay}>
      <Thumb id={video.id} duration={video.duration}/>
      <span className="tt-row-text">
        <span className="tt-title">{video.title}</span>
        <span className="tt-meta">{[video.channel, formatViews(video.viewCount)].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
    {(actions.onPlayNext || actions.onQueue || actions.onRemove) && <button className="tt-icon" aria-label="More" title="More" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreVertical/></button>}
    {menu && <div className="tt-menu" onClick={() => setMenu(false)}>
      {actions.onPlayNext && <button onClick={actions.onPlayNext}><ListVideo/>Play next</button>}
      {actions.onQueue && <button onClick={actions.onQueue}><ListPlus/>Add to queue</button>}
      {actions.onRemove && <button onClick={actions.onRemove}><Trash2/>Remove</button>}
    </div>}
  </li>
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="tt-section"><header><h2>{title}</h2>{action}</header>{children}</section>
}

function SettingsSheet({ onClose, engine }: { onClose(): void; engine: TomTubeEngine | null }) {
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
    <label className="tt-select"><span><b>Audio stream</b></span><select value={settings.audioFormat} onChange={(event) => change({ audioFormat: event.target.value as 'auto' | 'file' })}><option value="auto">Automatic (HLS)</option><option value="file">Single file (M4A)</option></select></label>
    <button className="tt-secondary" onClick={() => void checkServer()}>Check server</button>
    {status && <p className="tt-note">{status}</p>}
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

  useEffect(() => startMediaRoute({ username: session.username, token: session.token, salt: session.salt }), [session])

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
      {error && <div className="tt-error" role="alert">{error}</div>}
      {results ? <Section title={`Results for “${query.trim()}”`}>
        {results.length ? <ul className="tt-list">{results.map((video) => <VideoRow key={video.id} video={video} actions={rowActions(video)}/>)}</ul> : <p className="tt-note">Nothing found.</p>}
      </Section> : <>
        {upNext.length > 0 && <Section title="Up next" action={<button className="tt-link" onClick={() => updateQueue(Q.clearUpcoming(queue))}>Clear</button>}>
          <ul className="tt-list">{upNext.map(({ video, index }) => <VideoRow key={`${video.id}-${index}`} compact video={video} actions={{ onPlay: () => engine?.playAt(index), onRemove: () => updateQueue(Q.removeAt(queue, index)) }}/>)}</ul>
        </Section>}
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

    {settingsOpen && <SettingsSheet engine={engine} onClose={() => setSettingsOpen(false)}/>}
  </div>
}
