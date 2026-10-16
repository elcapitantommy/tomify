import { useEffect, useRef } from 'react'
import { usePlayer } from '../stores/player'
import {
  LIVE_PLAYBACK_ACTIVITY_EVENT,
  LivePlaybackConflict,
  currentRemoteSession,
  fetchLivePlayback,
  latestCommandRevision,
  nextPollDelay,
  leaveLivePlayback,
  localPlaybackDeviceId,
  pendingCommands,
  serverNow,
  useLivePlayback,
  type LivePlaybackSnapshot,
} from '../stores/livePlayback'
import { adoptSnapshot, applyCommand, localActivityAt, localSnapshot, markLocalActivity, publishLocal } from '../stores/playbackHandoff'

// The device that is playing re-sends its state at least this often, so others can correct drift.
const KEEPALIVE_MS = 30_000
// After any change, check quickly for a while so the other side's reaction shows up promptly.
const BURST_MS = 10_000

function isLocalOwner() {
  return useLivePlayback.getState().snapshot?.deviceId === localPlaybackDeviceId
}

export function LivePlaybackSync() {
  const activitySerial = usePlayer((state) => state.activitySerial)
  const lastActivitySerial = useRef(activitySerial)
  const takeoverUntil = useRef(0)
  const burstUntil = useRef(0)
  const wakeRef = useRef<() => void>(() => undefined)
  const schedulePublishRef = useRef<(takeover: boolean) => void>(() => undefined)

  useEffect(() => {
    if (activitySerial === lastActivitySerial.current) return
    lastActivitySerial.current = activitySerial
    burstUntil.current = Date.now() + BURST_MS

    // Adding to or reordering this device's own queue while another device plays shouldn't take playback away from it.
    if (currentRemoteSession() && !usePlayer.getState().playing) {
      wakeRef.current()
      return
    }

    markLocalActivity()
    const optimistic: LivePlaybackSnapshot = {
      ...localSnapshot(),
      updatedAt: serverNow(),
      revision: (useLivePlayback.getState().snapshot?.revision ?? 0) + 1,
    }
    takeoverUntil.current = Date.now() + 5000
    useLivePlayback.setState({ snapshot: optimistic, optimistic: null, connected: true })
    schedulePublishRef.current(true)
  }, [activitySerial])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    let polling = false
    let pollAgain = false
    let idleRounds = 0
    let lastSignature = ''
    let lastCommandRevision: number | null = null
    let lastAdoptedRevision = -1
    let lastPublishAt = 0
    let publishTimer: number | undefined
    let publishing = false
    let publishQueued = false
    let pendingTakeover = false

    const publish = async () => {
      if (publishing) { publishQueued = true; return }
      publishing = true
      const takeover = pendingTakeover
      pendingTakeover = false
      try {
        await publishLocal(takeover)
        lastPublishAt = Date.now()
      } catch (error) {
        // Another device took over in the meantime: check now so this one converges on it.
        if (error instanceof LivePlaybackConflict) wake()
      } finally {
        publishing = false
        if (publishQueued && !stopped) { publishQueued = false; void publish() }
      }
    }

    const schedulePublish = (takeover: boolean) => {
      pendingTakeover = pendingTakeover || takeover
      window.clearTimeout(publishTimer)
      publishTimer = window.setTimeout(() => { if (!stopped) void publish() }, 150)
    }
    schedulePublishRef.current = schedulePublish

    const schedule = () => {
      if (stopped) return
      window.clearTimeout(timer)
      const remote = currentRemoteSession()
      const delay = nextPollDelay({
        hidden: document.visibilityState === 'hidden',
        playingHere: usePlayer.getState().playing,
        remoteActive: Boolean(remote),
        remotePlaying: Boolean(remote?.playing),
        burst: Date.now() < burstUntil.current,
        idleRounds,
      })
      timer = window.setTimeout(() => void poll(), delay)
    }

    const poll = async () => {
      if (polling) { pollAgain = true; return }
      polling = true
      window.clearTimeout(timer)
      try {
        const result = await fetchLivePlayback()
        if (stopped || !result) return
        const { response, serverOffset } = result
        const remoteDuringTakeover = Boolean(response.state && response.state.deviceId !== localPlaybackDeviceId && Date.now() < takeoverUntil.current)
        if (remoteDuringTakeover) {
          // This device just took over; ignore the old owner's state until the takeover lands.
          useLivePlayback.setState({ devices: response.devices ?? [], serverOffset: serverOffset ?? useLivePlayback.getState().serverOffset, connected: true })
        } else {
          useLivePlayback.getState().applyServer(response, serverOffset)
        }

        const now = serverNow()
        if (lastCommandRevision === null) {
          // Commands sent before this page loaded are history, not instructions (a reload must not replay a "play").
          lastCommandRevision = latestCommandRevision(response)
        } else {
          for (const command of pendingCommands(response, lastCommandRevision, now)) {
            lastCommandRevision = command.revision
            burstUntil.current = Date.now() + BURST_MS
            applyCommand(command, response.state)
          }
        }

        if (!remoteDuringTakeover) {
          const remote = currentRemoteSession()
          const player = usePlayer.getState()
          if (remote?.playing && player.playing && remote.updatedAt > localActivityAt()) {
            // Another device started playing after this one: stop here, as Spotify does.
            usePlayer.setState({ playing: false })
          } else if (!remote && response.state && response.state.deviceId !== localPlaybackDeviceId && !player.playing &&
            response.state.revision !== lastAdoptedRevision && response.state.updatedAt > localActivityAt() && response.state.queue[response.state.currentIndex]) {
            // Nothing is playing elsewhere any more: pick up where the other device left off, ready to resume here.
            lastAdoptedRevision = response.state.revision
            adoptSnapshot(response.state)
          }
        }

        const signature = [response.state?.deviceId, response.state?.revision, latestCommandRevision(response), (response.devices ?? []).map((device) => device.deviceId).join(',')].join('|')
        idleRounds = signature === lastSignature ? idleRounds + 1 : 0
        lastSignature = signature

        if (usePlayer.getState().playing && isLocalOwner() && Date.now() - lastPublishAt > KEEPALIVE_MS) schedulePublish(false)
      } catch {
        if (!stopped) useLivePlayback.getState().setConnected(false)
      } finally {
        polling = false
        if (pollAgain && !stopped) { pollAgain = false; void poll() } else schedule()
      }
    }

    const wake = () => {
      idleRounds = 0
      void poll()
    }
    wakeRef.current = wake

    // Play state can change without a user action (headphones unplugged, the OS pausing audio, a track failing):
    // tell the other devices if this one owns playback.
    const unsubscribe = usePlayer.subscribe((state, previous) => {
      if (state.playing === previous.playing || state.activitySerial !== previous.activitySerial) return
      if (isLocalOwner()) schedulePublish(false)
      schedule()
    })

    const onActivity = () => {
      burstUntil.current = Date.now() + BURST_MS
      wake()
    }
    // Coming back to the foreground: if this device kept playing in the background, re-announce it in case
    // others stopped hearing from it (iOS can suspend the page, or mark it as gone on pagehide).
    const onReturn = () => {
      if (usePlayer.getState().playing && isLocalOwner()) schedulePublish(false)
      wake()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onReturn()
      else schedule()
    }
    const onPageHide = () => leaveLivePlayback(usePlayer.getState().currentTime)
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onReturn() }

    void poll()
    window.addEventListener(LIVE_PLAYBACK_ACTIVITY_EVENT, onActivity)
    window.addEventListener('focus', onActivity)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearTimeout(publishTimer)
      unsubscribe()
      wakeRef.current = () => undefined
      schedulePublishRef.current = () => undefined
      window.removeEventListener(LIVE_PLAYBACK_ACTIVITY_EVENT, onActivity)
      window.removeEventListener('focus', onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  return null
}
