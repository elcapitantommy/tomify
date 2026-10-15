import { ChevronDown, ListMusic, Maximize2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import { Artwork } from './Artwork'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../stores/player'
import { localPlaybackDeviceId, sendLivePlaybackCommand, useLivePlayback } from '../stores/livePlayback'

function usePlaybackView() {
  const player = usePlayer()
  const live = useLivePlayback((state) => state.snapshot)
  const remote = Boolean(
    live &&
    live.deviceId !== localPlaybackDeviceId &&
    Date.now() - live.updatedAt < 10_000 &&
    live.queue[live.currentIndex],
  )

  if (!remote || !live) {
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
      command: async () => false,
    }
  }

  const elapsed = live.playing ? Math.max(0, Date.now() - live.updatedAt) / 1000 : 0
  return {
    remote: true as const,
    deviceName: live.deviceName,
    queue: live.queue,
    currentIndex: live.currentIndex,
    playing: live.playing,
    currentTime: Math.min(live.duration || Infinity, live.currentTime + elapsed),
    duration: live.duration,
    volume: live.volume,
    muted: live.muted,
    shuffle: live.shuffle,
    repeat: live.repeat,
    command: (action: Parameters<typeof sendLivePlaybackCommand>[1], value?: number) => sendLivePlaybackCommand(live.deviceId, action, value),
  }
}

function Transport({ large = false }: { large?: boolean }) {
  const player = usePlayer()
  const view = usePlaybackView()
  const shuffle = () => view.remote ? void view.command('toggle-shuffle') : player.toggleShuffle()
  const previous = () => view.remote ? void view.command('previous') : player.previous()
  const togglePlaying = () => view.remote ? void view.command(view.playing ? 'pause' : 'play') : player.setPlaying(!player.playing)
  const next = () => view.remote ? void view.command('next') : player.next()
  const repeat = () => view.remote ? void view.command('cycle-repeat') : player.cycleRepeat()

  return <div className={`transport ${large ? 'large' : ''}`}><button className={view.shuffle ? 'active' : ''} onClick={shuffle} aria-label="Shuffle"><Shuffle/></button><button onClick={previous} aria-label="Previous track"><SkipBack fill="currentColor"/></button><button className="play-pause" onClick={togglePlaying} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button onClick={next} aria-label="Next track"><SkipForward fill="currentColor"/></button><button className={view.repeat !== 'off' ? 'active' : ''} onClick={repeat} aria-label={`Repeat ${view.repeat}`}>{view.repeat === 'one' ? <Repeat1/> : <Repeat/>}</button></div>
}

function SeekBar() {
  const player = usePlayer()
  const view = usePlaybackView()
  const seek = (value: number) => view.remote ? void view.command('seek', value) : player.seekTo(value)
  return <div className="seek"><span>{formatDuration(view.currentTime)}</span><input aria-label="Seek" type="range" min="0" max={view.duration || 1} value={Math.min(view.currentTime, view.duration || 1)} onChange={(event) => seek(Number(event.target.value))}/><span>{formatDuration(view.duration)}</span></div>
}

export function PlayerBar() {
  const player = usePlayer()
  const view = usePlaybackView()
  const track = view.queue[view.currentIndex]
  if (!track) return null

  const togglePlaying = () => view.remote ? void view.command(view.playing ? 'pause' : 'play') : player.setPlaying(!player.playing)
  const toggleMuted = () => view.remote ? void view.command('toggle-muted') : player.toggleMuted()
  const setVolume = (value: number) => view.remote ? void view.command('set-volume', value) : player.setVolume(value)

  return <><div className="player-bar"><button className="player-track" onClick={() => player.setNowPlayingOpen(true)}><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={160}/><span><strong>{track.title}</strong><small>{track.artist}{view.remote && view.deviceName ? ` · ${view.deviceName}` : ''}</small></span></button><div className="desktop-player-controls"><Transport/><SeekBar/></div><div className="player-actions"><button className="mobile-toggle" onClick={togglePlaying} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button onClick={() => player.setQueueOpen(true)} aria-label="Open queue"><ListMusic/></button><button onClick={toggleMuted} aria-label="Mute">{view.muted ? <VolumeX/> : <Volume2/>}</button><input className="volume" aria-label="Volume" type="range" min="0" max="1" step="0.01" value={view.volume} onChange={(event) => setVolume(Number(event.target.value))}/><button className="desktop-only" onClick={() => player.setNowPlayingOpen(true)} aria-label="Full screen player"><Maximize2/></button></div><div className="mobile-player-progress"><SeekBar/></div></div><QueueDrawer/><NowPlaying/></>
}

function QueueDrawer() {
  const player = usePlayer()
  const view = usePlaybackView()
  if (!player.queueOpen) return null

  const playIndex = (index: number) => view.remote ? void view.command('play-index', index) : player.playTracks(player.queue, index)
  const removeIndex = (index: number) => view.remote ? void view.command('remove-index', index) : player.removeFromQueue(index)
  const clear = () => view.remote ? void view.command('clear-queue') : player.clearQueue()

  return <div className="drawer-backdrop" onMouseDown={() => player.setQueueOpen(false)}><aside className="queue-drawer" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">{view.remote && view.deviceName ? `Playing on ${view.deviceName}` : 'Up next'}</span><h2>Queue</h2></div><button onClick={() => player.setQueueOpen(false)} aria-label="Close queue"><X/></button></header><div className="queue-list">{view.queue.map((track, index) => <div className={index === view.currentIndex ? 'queue-item active' : 'queue-item'} key={`${track.id}-${index}`}><button onClick={() => playIndex(index)}><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={100}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button><button onClick={() => removeIndex(index)} aria-label={`Remove ${track.title}`}><X/></button></div>)}</div><button className="button secondary clear" onClick={clear}>Clear queue</button></aside></div>
}

function NowPlaying() {
  const player = usePlayer()
  const view = usePlaybackView()
  const track = view.queue[view.currentIndex]
  if (!player.nowPlayingOpen || !track) return null

  return <section className="now-playing"><header><button onClick={() => player.setNowPlayingOpen(false)} aria-label="Close now playing"><ChevronDown/></button><span>{view.remote && view.deviceName ? `Playing on ${view.deviceName}` : 'Now playing'}</span><button onClick={() => { player.setNowPlayingOpen(false); player.setQueueOpen(true) }} aria-label="Open queue"><ListMusic/></button></header><div className="now-art"><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={1000}/></div><div className="now-meta"><span><h1>{track.title}</h1><p>{track.artist}</p></span></div><SeekBar/><Transport large/></section>
}
