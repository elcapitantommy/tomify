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
import {
  LIVE_PLAYBACK_FRESH_MS,
  POLL_FAST_MS,
  POLL_MAX_MS,
  PUBLISH_CHECK_MS,
  nextPollDelay,
  shouldPublish,
  snapshotSignature,
  type PublishedRecord,
} from '../lib/live-playback-timing'

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

function ownsActivePlayback() {
  const live = useLivePlayback.getState().snapshot
  const player = usePlayer.getState()
  return live?.deviceId === localPlaybackDeviceId && player.playing && Boolean(player.queue[player.currentIndex])
}

/**
 * A hidden tab goes quiet, unless it is the device actually playing: then it keeps a slow
 * poll (so other devices can still control it) and the keep-alive (so they still see it).
 */
function timersAllowed() {
  return !document.hidden || ownsActivePlayback()
}

export function LivePlaybackSync() {
  const activitySerial = usePlayer((state) => state.activitySerial)
  const setSnapshot = useLivePlayback((state) => state.setSnapshot)
  const setConnected = useLivePlayback((state) => state.setConnected)
  const lastCommandRevision = useRef(0)
  const commandInitialised = useRef(false)
  const lastActivitySerial = useRef(activitySerial)
  const publishing = useRef(false)
  const takeoverUntil = useRef(0)
  const lastPublished = useRef<PublishedRecord | null>(null)
  const resume = useRef<() => void>(() => {})

  const publish = async (takeover = false) => {
    if (publishing.current) return
    publishing.current = true
    try {
      const snapshot = snapshotFromPlayer()
      const at = Date.now()
      const state = await publishLivePlayback(snapshot, takeover)
      lastPublished.current = { signature: snapshotSignature(snapshot), currentTime: snapshot.currentTime, playing: snapshot.playing, at }
      if (state) {
        setSnapshot(state)
        setConnected(true)
      }
    } catch {
      // A stale device heartbeat may be rejected after another device takes over.
      // Polling will immediately converge on the current owner, so don't mark the
      // live connection as broken for an ownership conflict.
    } finally {
      publishing.current = false
    }
  }

  useEffect(() => {
    if (activitySerial === lastActivitySerial.current) return
    lastActivitySerial.current = activitySerial

    const optimistic = {
      ...snapshotFromPlayer(),
      updatedAt: Date.now(),
      revision: (useLivePlayback.getState().snapshot?.revision ?? 0) + 1,
    }
    takeoverUntil.current = Date.now() + 5000
    setSnapshot(optimistic)
    setConnected(true)
    void publish(true)
    resume.current()
  }, [activitySerial]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stopped = false
    let polling = false
    let pollDelay = POLL_FAST_MS
    let pollTimer: number | undefined
    let publishTimer: number | undefined
    let lastRemote: { deviceId: string | null; revision: number } | null = null

    // Resolves to true when something changed that should keep polling fast.
    const poll = async () => {
      try {
        const result = await fetchLivePlayback()
        if (stopped) return false
        setConnected(true)
        const state = result.state
        let changed = !lastRemote ||
          lastRemote.deviceId !== (state?.deviceId ?? null) ||
          (Boolean(state) && state?.deviceId !== localPlaybackDeviceId && lastRemote.revision !== state?.revision)
        lastRemote = { deviceId: state?.deviceId ?? null, revision: state?.revision ?? 0 }

        const remoteDuringTakeover = state &&
          state.deviceId !== localPlaybackDeviceId &&
          Date.now() < takeoverUntil.current

        if (!remoteDuringTakeover) {
          setSnapshot(state)

          if (state && state.deviceId !== localPlaybackDeviceId && Date.now() - state.updatedAt < LIVE_PLAYBACK_FRESH_MS) {
            const localPlayer = usePlayer.getState()
            if (localPlayer.playing) usePlayer.setState({ playing: false })
          }
        }

        const command = result.command
        if (!commandInitialised.current) {
          lastCommandRevision.current = command?.revision ?? 0
          commandInitialised.current = true
        } else if (command && command.targetDeviceId === localPlaybackDeviceId && command.revision > lastCommandRevision.current) {
          lastCommandRevision.current = command.revision
          changed = true
          applyCommand(command)
          window.setTimeout(() => { if (!stopped) void publish(false) }, 100)
        }
        return changed
      } catch {
        if (!stopped) setConnected(false)
        return false
      }
    }

    const schedulePoll = () => {
      window.clearTimeout(pollTimer)
      pollTimer = undefined
      if (stopped || polling || !timersAllowed()) return
      pollTimer = window.setTimeout(() => void runPoll(), document.hidden ? POLL_MAX_MS : pollDelay)
    }

    const runPoll = async () => {
      window.clearTimeout(pollTimer)
      pollTimer = undefined
      if (stopped || polling) return
      polling = true
      const changed = await poll()
      polling = false
      pollDelay = nextPollDelay(pollDelay, changed)
      schedulePoll()
    }

    const schedulePublish = () => {
      window.clearTimeout(publishTimer)
      publishTimer = undefined
      if (stopped || !timersAllowed()) return
      publishTimer = window.setTimeout(() => {
        publishTimer = undefined
        const live = useLivePlayback.getState().snapshot
        const player = usePlayer.getState()
        if (live?.deviceId === localPlaybackDeviceId && player.queue[player.currentIndex] &&
          shouldPublish(snapshotFromPlayer(), lastPublished.current, Date.now())) void publish(false)
        schedulePublish()
      }, PUBLISH_CHECK_MS)
    }

    // Local activity: poll fast again and make sure both loops are running.
    resume.current = () => {
      pollDelay = POLL_FAST_MS
      schedulePoll()
      if (publishTimer === undefined) schedulePublish()
    }

    const pollNow = () => {
      pollDelay = POLL_FAST_MS
      void runPoll()
      if (publishTimer === undefined) schedulePublish()
    }

    const onVisibilityChange = () => {
      if (!document.hidden) { pollNow(); return }
      if (timersAllowed()) return
      window.clearTimeout(pollTimer)
      window.clearTimeout(publishTimer)
      pollTimer = undefined
      publishTimer = undefined
    }

    void runPoll()
    schedulePublish()
    window.addEventListener('focus', pollNow)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopped = true
      resume.current = () => {}
      window.clearTimeout(pollTimer)
      window.clearTimeout(publishTimer)
      window.removeEventListener('focus', pollNow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [setConnected, setSnapshot]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
