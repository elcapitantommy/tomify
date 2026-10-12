import { useEffect, useRef } from 'react'
import { usePlayer } from '../stores/player'
import {
  fetchLivePlayback,
  localPlaybackDeviceId,
  localPlaybackDeviceName,
  publishLivePlayback,
  useLivePlayback,
  type LivePlaybackCommand,
} from '../stores/livePlayback'

function snapshotFromPlayer() {
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

async function publishCurrent() {
  const state = usePlayer.getState()
  if (!state.queue[state.currentIndex]) return null
  return publishLivePlayback(snapshotFromPlayer())
}

function applyCommand(command: LivePlaybackCommand) {
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
  }
}

export function LivePlaybackSync() {
  const activitySerial = usePlayer((state) => state.activitySerial)
  const setSnapshot = useLivePlayback((state) => state.setSnapshot)
  const setConnected = useLivePlayback((state) => state.setConnected)
  const lastCommandRevision = useRef(0)
  const lastActivitySerial = useRef(activitySerial)
  const publishing = useRef(false)

  const publish = async () => {
    if (publishing.current) return
    publishing.current = true
    try {
      const state = await publishCurrent()
      if (state) {
        setSnapshot(state)
        setConnected(true)
      }
    } catch {
      setConnected(false)
    } finally {
      publishing.current = false
    }
  }

  useEffect(() => {
    if (activitySerial === lastActivitySerial.current) return
    lastActivitySerial.current = activitySerial
    void publish()
  }, [activitySerial]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stopped = false

    const poll = async () => {
      try {
        const result = await fetchLivePlayback()
        if (stopped) return
        setConnected(true)
        setSnapshot(result.state)

        const command = result.command
        if (command && command.targetDeviceId === localPlaybackDeviceId && command.revision > lastCommandRevision.current) {
          lastCommandRevision.current = command.revision
          applyCommand(command)
          window.setTimeout(() => { if (!stopped) void publish() }, 100)
        }
      } catch {
        if (!stopped) setConnected(false)
      }
    }

    void poll()
    const pollTimer = window.setInterval(poll, 1500)
    const publishTimer = window.setInterval(() => {
      const live = useLivePlayback.getState().snapshot
      const player = usePlayer.getState()
      if (live?.deviceId === localPlaybackDeviceId && player.queue[player.currentIndex]) void publish()
    }, 3000)

    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)

    return () => {
      stopped = true
      window.clearInterval(pollTimer)
      window.clearInterval(publishTimer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [setConnected, setSnapshot]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
