import type { Track } from '../types'
import { usePlayer } from './player'
import {
  LivePlaybackConflict,
  controlRemote,
  currentRemoteSession,
  livePosition,
  localPlaybackDeviceId,
  localPlaybackDeviceName,
  publishLivePlayback,
  sendLivePlaybackCommand,
  serverNow,
  useLivePlayback,
  type LivePlaybackCommand,
  type LivePlaybackSnapshot,
} from './livePlayback'

// Must match the Worker (worker/features/live-playback.ts).
export const MAX_PLAY_NEXT = 200

const LOCAL_ACTIVITY_KEY = 'tomify-live-local-activity'

// When this device last changed playback itself, on the server's clock. Another device's newer state wins over it.
export function localActivityAt() {
  try { return Number(window.localStorage.getItem(LOCAL_ACTIVITY_KEY)) || 0 } catch { return 0 }
}

export function markLocalActivity() {
  try { window.localStorage.setItem(LOCAL_ACTIVITY_KEY, String(serverNow())) } catch { /* storage unavailable */ }
}

export function localSnapshot() {
  const state = usePlayer.getState()
  return {
    deviceId: localPlaybackDeviceId,
    deviceName: localPlaybackDeviceName,
    queue: state.queue,
    currentIndex: state.currentIndex,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
    volume: state.volume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
  }
}

export async function publishLocal(takeover = false) {
  const state = await publishLivePlayback(localSnapshot(), takeover)
  useLivePlayback.setState({ snapshot: state, connected: true })
  return state
}

// Loads another device's queue and position here without playing, so pressing play continues where it left off.
export function adoptSnapshot(snapshot: LivePlaybackSnapshot) {
  usePlayer.setState({
    queue: snapshot.queue,
    currentIndex: snapshot.currentIndex,
    currentTime: livePosition(snapshot, serverNow()),
    duration: snapshot.duration,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    playing: false,
    unshuffledQueue: null,
  })
}

// Moves playback from another device to this one, carrying on from the same track and position.
export function playHere(snapshot: LivePlaybackSnapshot) {
  const position = livePosition(snapshot, serverNow())
  usePlayer.setState({ shuffle: snapshot.shuffle, repeat: snapshot.repeat })
  usePlayer.getState().playTracks(snapshot.queue, snapshot.currentIndex, { keepOrder: true })
  if (position > 1) usePlayer.getState().seekTo(position)
}

// Asks another open device to take over. This device keeps playing until that one starts, then pauses itself.
export async function transferTo(deviceId: string) {
  if (deviceId === localPlaybackDeviceId) {
    const remote = currentRemoteSession()
    if (remote) playHere(remote)
    return true
  }
  const live = useLivePlayback.getState().snapshot
  const player = usePlayer.getState()
  if (live?.deviceId === deviceId) return true
  // The other device starts from the shared state, so make sure it holds this device's latest queue and position.
  if (player.queue[player.currentIndex] && !currentRemoteSession()) {
    try { await publishLocal(true) } catch (error) { if (!(error instanceof LivePlaybackConflict)) return false }
  }
  return sendLivePlaybackCommand(deviceId, 'transfer')
}

// "Add to queue" goes to whichever device is playing, like Spotify.
export function addToQueueAnywhere(track: Track) {
  const remote = currentRemoteSession()
  if (remote) controlRemote(remote, 'add-to-queue', undefined, track)
  else usePlayer.getState().addToQueue(track)
}

// Play next on whichever device is playing.
export function playNextAnywhere(tracks: Track[]) {
  if (!tracks.length) return
  const remote = currentRemoteSession()
  if (remote) controlRemote(remote, 'play-next', undefined, undefined, tracks.slice(0, MAX_PLAY_NEXT))
  else usePlayer.getState().playNext(tracks)
}

export function applyCommand(command: LivePlaybackCommand, snapshot: LivePlaybackSnapshot | null) {
  const player = usePlayer.getState()
  switch (command.action) {
    case 'play': player.setPlaying(true); break
    case 'pause': player.setPlaying(false); break
    case 'next': player.next(); break
    case 'previous': player.previous(); break
    case 'seek': if (typeof command.value === 'number') player.seekTo(command.value); break
    case 'toggle-shuffle': player.toggleShuffle(); break
    case 'cycle-repeat': player.cycleRepeat(); break
    case 'play-index':
      if (typeof command.value === 'number' && player.queue[command.value]) player.playTracks(player.queue, command.value)
      break
    case 'remove-index': if (typeof command.value === 'number') player.removeFromQueue(command.value); break
    case 'clear-queue': player.clearQueue(); break
    case 'toggle-muted': player.toggleMuted(); break
    case 'set-volume': if (typeof command.value === 'number') player.setVolume(command.value); break
    case 'add-to-queue': if (command.track) player.addToQueue(command.track); break
    case 'play-next': if (command.tracks?.length) player.playNext(command.tracks); break
    case 'transfer': if (snapshot && snapshot.deviceId !== localPlaybackDeviceId && snapshot.queue[snapshot.currentIndex]) playHere(snapshot); break
  }
}
