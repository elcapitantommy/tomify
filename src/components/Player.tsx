import { useEffect, useRef, useState } from 'react'
import { Airplay, Car, Cast, Check, ChevronDown, ListMusic, Maximize2, MicVocal, MonitorSpeaker, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import { Artwork } from './Artwork'
import { ItemArtists } from './ArtistLinks'
import { StartRadioButton } from './SongRadio'
import { useRadio } from '../stores/radio'
import { LyricsPanel } from './Lyrics'
import { SleepTimerButton } from './SleepTimer'
import { RatingStars } from './RatingStars'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../stores/player'
import { controlRemote, isDeviceOnline, livePosition, localPlaybackDeviceId, localPlaybackDeviceName, useLivePlayback, useRemoteSession, type LivePlaybackCommandAction } from '../stores/livePlayback'
import { playHere, transferTo } from '../stores/playbackHandoff'
import { promptCast, useCast } from '../stores/cast'
import { castLabels } from '../lib/cast'
import { DragHandle } from './DragHandle'
import { CarMode } from './CarMode'
import { useCarMode } from '../stores/carMode'
import { LiveRadioBar } from './LiveRadio'
import { ShareLinkButton } from './ShareLink'
import { useLiveRadio } from '../stores/liveRadio'

const noCommand = (action: LivePlaybackCommandAction, value?: number) => { void action; void value }

// eslint-disable-next-line react-refresh/only-export-components
export function usePlaybackView() {
  const player = usePlayer()
  const { remote, now } = useRemoteSession(500)

  if (!remote) {
    return {
      remote: false as const,
      deviceName: undefined,
      queue: player.queue,
      currentIndex: player.currentIndex,
      playing: player.playing,
      currentTime: player.currentTime,
      duration: player.duration,
      volume: player.volume,
      muted: player.muted,
      shuffle: player.shuffle,
      repeat: player.repeat,
      command: noCommand,
      playHere: () => undefined,
    }
  }

  return {
    remote: true as const,
    deviceName: remote.deviceName,
    queue: remote.queue,
    currentIndex: remote.currentIndex,
    playing: remote.playing,
    currentTime: livePosition(remote, now),
    duration: remote.duration,
    volume: remote.volume,
    muted: remote.muted,
    shuffle: remote.shuffle,
    repeat: remote.repeat,
    command: (action: LivePlaybackCommandAction, value?: number) => controlRemote(remote, action, value),
    playHere: () => playHere(remote),
  }
}

function remoteLabel(view: ReturnType<typeof usePlaybackView>) {
  return view.remote && view.deviceName ? `${view.playing ? 'Playing' : 'Paused'} on ${view.deviceName}` : undefined
}

// Spotify-style device list: every Tomify tab or app open on this account, and where playback is now.
export function DevicePicker({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const devices = useLivePlayback((state) => state.devices)
  const { remote, now } = useRemoteSession(5000)
  const container = useRef<HTMLDivElement>(null)
  const activeId = remote?.deviceId ?? localPlaybackDeviceId
  const cast = useCast()
  const casting = !remote && cast.state !== 'disconnected'
  const castLabel = cast.kind ? castLabels[cast.kind] : null
  const CastIcon = cast.kind === 'airplay' ? Airplay : Cast
  const others = devices.filter((device) => device.deviceId !== localPlaybackDeviceId && isDeviceOnline(devices, device.deviceId, now))

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const choose = async (deviceId: string) => {
    if (deviceId === activeId) { setOpen(false); return }
    setBusy(deviceId)
    setError(null)
    const ok = await transferTo(deviceId).catch(() => false)
    setBusy(null)
    if (ok) setOpen(false)
    else setError('That device did not respond. Is Tomify still open there?')
  }

  const items = [{ deviceId: localPlaybackDeviceId, deviceName: localPlaybackDeviceName, label: 'This device' }, ...others.map((device) => ({ ...device, label: device.deviceName }))]

  return <div className={`device-picker ${placement}`} ref={container}>
    <button type="button" className={remote || casting ? 'device-button remote' : 'device-button'} onClick={() => setOpen(!open)} aria-label="Connect to a device" aria-expanded={open} title={remote ? `Playing on ${remote.deviceName}` : casting ? 'Playing on a speaker' : 'Connect to a device'}>{casting ? <CastIcon/> : <MonitorSpeaker/>}</button>
    {open && <div className="device-menu" role="menu">
      <strong>Connect to a device</strong>
      {items.map((item) => <button type="button" role="menuitem" key={item.deviceId} className={item.deviceId === activeId ? 'active' : ''} disabled={busy !== null} onClick={() => void choose(item.deviceId)}>
        <MonitorSpeaker/><span>{item.label}{item.deviceId === localPlaybackDeviceId && <small>{item.deviceName}</small>}{item.deviceId === activeId && <small>{remote ? (remote.playing ? 'Playing' : 'Paused') : casting ? 'Sending to a speaker' : 'Listening here'}</small>}{busy === item.deviceId && <small>Connecting…</small>}</span>
        {item.deviceId === activeId && <Check/>}
      </button>)}
      {castLabel && !remote && <button type="button" role="menuitem" className={casting ? 'active cast-item' : 'cast-item'} onClick={() => promptCast()}>
        <CastIcon/><span>{castLabel.action}<small>{cast.state === 'connected' ? 'Playing on a speaker. Tap to change or stop.' : cast.state === 'connecting' ? 'Connecting…' : castLabel.detail}</small></span>
        {cast.state === 'connected' && <Check/>}
      </button>}
      {cast.error && !remote && <p className="device-error">{cast.error}</p>}
      {!others.length && <p>Open Tomify on another phone or computer signed in to this account to play there.</p>}
      {error && <p className="device-error">{error}</p>}
    </div>}
  </div>
}

function Transport({ large = false }: { large?: boolean }) {
  const player = usePlayer()
  const view = usePlaybackView()
  const shuffle = () => view.remote ? view.command('toggle-shuffle') : player.toggleShuffle()
  const previous = () => view.remote ? view.command('previous') : player.previous()
  const togglePlaying = () => view.remote ? view.command(view.playing ? 'pause' : 'play') : player.setPlaying(!player.playing)
  const next = () => view.remote ? view.command('next') : player.next()
  const repeat = () => view.remote ? view.command('cycle-repeat') : player.cycleRepeat()

  return <div className={`transport ${large ? 'large' : ''}`}><button className={view.shuffle ? 'active' : ''} onClick={shuffle} aria-label="Shuffle"><Shuffle/></button><button onClick={previous} aria-label="Previous track"><SkipBack fill="currentColor"/></button><button className="play-pause" onClick={togglePlaying} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button onClick={next} aria-label="Next track"><SkipForward fill="currentColor"/></button><button className={view.repeat !== 'off' ? 'active' : ''} onClick={repeat} aria-label={`Repeat ${view.repeat}`}>{view.repeat === 'one' ? <Repeat1/> : <Repeat/>}</button></div>
}

function SeekBar() {
  const player = usePlayer()
  const view = usePlaybackView()
  const seek = (value: number) => view.remote ? view.command('seek', value) : player.seekTo(value)
  return <div className="seek"><span>{formatDuration(view.currentTime)}</span><input aria-label="Seek" type="range" min="0" max={view.duration || 1} value={Math.min(view.currentTime, view.duration || 1)} onChange={(event) => seek(Number(event.target.value))}/><span>{formatDuration(view.duration)}</span></div>
}

export function PlayerBar() {
  const player = usePlayer()
  const view = usePlaybackView()
  const radioOn = useLiveRadio((state) => state.station !== null)
  const track = view.queue[view.currentIndex]
  if (radioOn) return <LiveRadioBar/>
  if (!track) return null

  const togglePlaying = () => view.remote ? view.command(view.playing ? 'pause' : 'play') : player.setPlaying(!player.playing)
  const toggleMuted = () => view.remote ? view.command('toggle-muted') : player.toggleMuted()
  const setVolume = (value: number) => view.remote ? view.command('set-volume', value) : player.setVolume(value)

  return <><div className="player-bar"><div className="player-track"><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={160}/><span><button type="button" className="player-track-open" onClick={() => player.setNowPlayingOpen(true)}><strong>{track.title}</strong></button><small><ItemArtists item={track}/>{view.remote && view.deviceName ? <em className="remote-device"> · {view.deviceName}</em> : null}</small></span></div><div className="desktop-player-controls"><Transport/><SeekBar/></div><div className="player-actions"><DevicePicker/><button className="mobile-toggle" onClick={togglePlaying} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button onClick={() => player.setQueueOpen(true)} aria-label="Open queue"><ListMusic/></button><button onClick={toggleMuted} aria-label="Mute">{view.muted ? <VolumeX/> : <Volume2/>}</button><input className="volume" aria-label="Volume" type="range" min="0" max="1" step="0.01" value={view.volume} onChange={(event) => setVolume(Number(event.target.value))}/><button className="desktop-only" onClick={() => player.setNowPlayingOpen(true)} aria-label="Full screen player"><Maximize2/></button></div><div className="mobile-player-progress"><SeekBar/></div></div><QueueDrawer/><NowPlaying/><CarMode/></>
}

function QueueDrawer() {
  const player = usePlayer()
  const view = usePlaybackView()
  const radio = useRadio()
  if (!player.queueOpen) return null
  const radioLabel = !view.remote && radio.seed ? `Radio · ${radio.seed.title}` : undefined

  const playIndex = (index: number) => view.remote ? view.command('play-index', index) : player.playTracks(player.queue, index)
  const removeIndex = (index: number) => view.remote ? view.command('remove-index', index) : player.removeFromQueue(index)
  const clear = () => view.remote ? view.command('clear-queue') : player.clearQueue()

  return <div className="drawer-backdrop" onMouseDown={() => player.setQueueOpen(false)}><aside className="queue-drawer" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">{remoteLabel(view) ?? radioLabel ?? 'Up next'}</span><h2>Queue</h2>{radioLabel && (radio.loading || radio.error) && <small className="radio-status">{radio.error ?? 'Finding similar songs…'}</small>}</div><button onClick={() => player.setQueueOpen(false)} aria-label="Close queue"><X/></button></header><div className="queue-list">{view.queue.map((track, index) => <div className={index === view.currentIndex ? 'queue-item active' : 'queue-item'} key={`${track.id}-${index}`}><div className="queue-open"><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={100}/><span><button type="button" className="queue-play" onClick={() => playIndex(index)}><strong>{track.title}</strong></button><small><ItemArtists item={track} onNavigate={() => player.setQueueOpen(false)}/></small></span></div>{!view.remote && <DragHandle index={index} count={view.queue.length} label={track.title} onMove={(from, to) => player.moveInQueue(from, to)}/>}<button onClick={() => removeIndex(index)} aria-label={`Remove ${track.title}`}><X/></button></div>)}</div><button className="button secondary clear" onClick={clear}>Clear queue</button></aside></div>
}

const LYRICS_KEY = 'tomify-lyrics-open'
const lyricsWereOpen = () => { try { return window.localStorage.getItem(LYRICS_KEY) === '1' } catch { return false } }

function NowPlaying() {
  const player = usePlayer()
  const view = usePlaybackView()
  const [lyricsOpen, setLyricsOpen] = useState(lyricsWereOpen)
  const track = view.queue[view.currentIndex]
  if (!player.nowPlayingOpen || !track) return null

  const toggleLyrics = () => {
    setLyricsOpen(!lyricsOpen)
    try { window.localStorage.setItem(LYRICS_KEY, lyricsOpen ? '0' : '1') } catch { /* storage unavailable */ }
  }
  const seek = (value: number) => view.remote ? view.command('seek', value) : player.seekTo(value)

  return <section className="now-playing"><header><button onClick={() => player.setNowPlayingOpen(false)} aria-label="Close now playing"><ChevronDown/></button><span>{remoteLabel(view) ?? 'Now playing'}</span><span className="now-playing-actions"><button className={lyricsOpen ? 'active' : ''} onClick={toggleLyrics} aria-label={lyricsOpen ? 'Hide lyrics' : 'Show lyrics'} aria-pressed={lyricsOpen}><MicVocal/></button>{!view.remote && <SleepTimerButton/>}<button onClick={() => { player.setNowPlayingOpen(false); useCarMode.getState().setOpen(true) }} aria-label="Car mode" title="Car mode"><Car/></button><ShareLinkButton key={track.id} ids={[track.id]} label={track.title} variant="icon"/><DevicePicker placement="down"/><button onClick={() => { player.setNowPlayingOpen(false); player.setQueueOpen(true) }} aria-label="Open queue"><ListMusic/></button></span></header>{lyricsOpen ? <LyricsPanel track={track} time={view.currentTime} onSeek={seek}/> : <div className="now-art"><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={1000}/></div>}<div className="now-meta"><span><h1>{track.title}</h1><p><ItemArtists item={track} onNavigate={() => player.setNowPlayingOpen(false)}/></p><RatingStars key={track.id} item={track} name={track.title} className="now-rating"/></span>{!view.remote && <StartRadioButton track={track} className="now-radio"/>}</div><SeekBar/><Transport large/>{view.remote && <button type="button" className="button secondary play-here" onClick={view.playHere}><MonitorSpeaker/>Play on this device</button>}</section>
}
