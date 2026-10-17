import { useEffect, useRef } from 'react'
import { useApi } from '../lib/api-context'
import { StreamFirstSourceResolver } from '../lib/sourceResolver'
import { bindPlayerRuntime, usePlayer } from '../stores/player'
import { setMediaMetadata } from '../lib/mediaSession'
import { albumArtworkUrl, useAlbumArtwork } from '../stores/albumArtwork'
import { RETRY_DELAYS_MS, STALL_TIMEOUT_MS } from '../lib/playbackRecovery'
import type { Track } from '../types'

type AudioSlot = 0 | 1

// A paused player only fetches enough to show the duration. A full preload of a
// restored track on every page load downloads whole FLACs nobody asked for, and
// those stalled downloads hold up the rest of the app's requests.
const preloadFor = (playing: boolean) => playing ? 'auto' : 'metadata'

// Every open copy of Tomify on a device shares one live-playback device id, so
// the server can't tell them apart. They tell each other directly instead: the
// copy that starts playing announces it and any other copy stops.
const PLAYER_CHANNEL = 'tomify-player'
const newInstanceId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function PlayerRuntime() {
  const audioA = useRef<HTMLAudioElement>(null)
  const audioB = useRef<HTMLAudioElement>(null)
  const activeSlot = useRef<AudioSlot>(0)
  const loadedTrackIds = useRef<[string | undefined, string | undefined]>([undefined, undefined])
  const submittedTrackId = useRef<string | undefined>(undefined)
  const nowPlayingTrackId = useRef<string | undefined>(undefined)
  const restoredPositionTrackId = useRef<string | undefined>(undefined)
  const initialRestore = useRef<{ trackId?: string; position: number } | null>(null)
  const resumeAt = useRef<{ slot: AudioSlot; trackId: string; position: number } | null>(null)
  const retries = useRef(0)
  const retryTimer = useRef<number | undefined>(undefined)
  const stallTimer = useRef<number | undefined>(undefined)
  const instanceId = useRef(newInstanceId())
  const channel = useRef<BroadcastChannel | null>(null)
  const api = useApi()
  const queue = usePlayer((s) => s.queue)
  const currentIndex = usePlayer((s) => s.currentIndex)
  const playing = usePlayer((s) => s.playing)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const track = queue[currentIndex]
  // Tomify's replacement covers load after the player restores, and can change while a
  // track plays, so the lock screen and car display must be refreshed when they do.
  const artworkOverride = useAlbumArtwork((s) => track?.albumId ? albumArtworkUrl(s.overrides[track.albumId]) : undefined)

  if (initialRestore.current === null) {
    const state = usePlayer.getState()
    initialRestore.current = {
      trackId: state.queue[state.currentIndex]?.id,
      position: state.currentTime,
    }
  }

  useEffect(() => {
    submittedTrackId.current = undefined
    retries.current = 0
    clearRetry()
    clearStall()
  }, [track?.id])

  useEffect(() => () => { clearRetry(); clearStall() }, [])

  // Tell Navidrome "now playing" only once the track actually plays, not when a page load restores a paused queue.
  useEffect(() => {
    if (!track || !playing || nowPlayingTrackId.current === track.id) return
    nowPlayingTrackId.current = track.id
    void api.scrobble(track.id, false).catch(() => undefined)
  }, [api, playing, track?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const getAudio = (slot: AudioSlot) => slot === 0 ? audioA.current : audioB.current
  const currentAudio = () => getAudio(activeSlot.current)

  function pauseAll() {
    for (const slot of [0, 1] as const) {
      const element = getAudio(slot)
      if (element && !element.paused) element.pause()
    }
  }

  function clearRetry() {
    if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current)
    retryTimer.current = undefined
  }

  function clearStall() {
    if (stallTimer.current !== undefined) window.clearTimeout(stallTimer.current)
    stallTimer.current = undefined
  }

  // Reload a broken stream and carry on from the same spot. A failed standby
  // element is only forgotten, so the next hand-off loads its track fresh
  // instead of switching to a stream that already died.
  function recover(slot: AudioSlot) {
    if (activeSlot.current !== slot) {
      loadedTrackIds.current[slot] = undefined
      return
    }
    const state = usePlayer.getState()
    const wanted = state.queue[state.currentIndex]
    const element = getAudio(slot)
    if (!element || !wanted || !state.playing || retryTimer.current !== undefined) return
    clearStall()
    if (retries.current >= RETRY_DELAYS_MS.length) {
      retries.current = 0
      state.setPlaying(false)
      return
    }
    const position = Number.isFinite(element.currentTime) && element.currentTime > 0 ? element.currentTime : state.currentTime
    const delay = RETRY_DELAYS_MS[retries.current]
    retries.current += 1
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = undefined
      const now = usePlayer.getState()
      if (!now.playing || activeSlot.current !== slot || now.queue[now.currentIndex]?.id !== wanted.id) return
      resumeAt.current = position > 0 ? { slot, trackId: wanted.id, position } : null
      element.src = api.streamUrl(wanted.id)
      element.preload = 'auto'
      element.load()
      loadedTrackIds.current[slot] = wanted.id
      playElement(element, slot)
    }, delay)
  }

  // play() is rejected with AbortError whenever a newer load() interrupts it;
  // that is not a failure. A blocked autoplay pauses; anything else is a broken
  // source and goes through recovery.
  function playElement(element: HTMLAudioElement, slot: AudioSlot) {
    const attempt = element.play()
    if (!attempt) return
    void attempt.catch((error: unknown) => {
      const name = error instanceof Error || (typeof error === 'object' && error !== null) ? (error as { name?: string }).name : undefined
      if (name === 'AbortError') return
      if (activeSlot.current !== slot) return
      if (name === 'NotAllowedError') usePlayer.getState().setPlaying(false)
      else recover(slot)
    })
  }

  function watchForStall(slot: AudioSlot) {
    if (activeSlot.current !== slot || !usePlayer.getState().playing || stallTimer.current !== undefined) return
    stallTimer.current = window.setTimeout(() => {
      stallTimer.current = undefined
      if (activeSlot.current === slot && usePlayer.getState().playing) recover(slot)
    }, STALL_TIMEOUT_MS)
  }

  useEffect(() => bindPlayerRuntime({
    seek: (value) => {
      const element = currentAudio()
      if (element) element.currentTime = value
    },
    volume: (value, isMuted) => {
      for (const slot of [0, 1] as const) {
        const element = getAudio(slot)
        if (element) {
          element.volume = value
          element.muted = isMuted
        }
      }
    },
    start: (nextTrack: Track) => {
      const current = activeSlot.current
      const standby = (current === 0 ? 1 : 0) as AudioSlot
      let target = current

      if (loadedTrackIds.current[current] !== nextTrack.id && loadedTrackIds.current[standby] === nextTrack.id && !getAudio(standby)?.error) {
        activeSlot.current = standby
        target = standby
      }
      // Only one element may ever be heard.
      const other = getAudio(target === 0 ? 1 : 0)
      if (other && !other.paused) other.pause()

      const element = getAudio(target)
      if (!element) return

      const url = api.streamUrl(nextTrack.id)
      const trackChanged = loadedTrackIds.current[target] !== nextTrack.id
      if (trackChanged || element.src !== url || element.error) {
        element.src = url
        element.load()
        loadedTrackIds.current[target] = nextTrack.id
      }
      element.preload = 'auto'

      if (element.ended) element.currentTime = 0

      playElement(element, target)
    },
  }), [api]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!track) return
    const slot = activeSlot.current
    const element = getAudio(slot)
    if (!element) return
    if (loadedTrackIds.current[slot] !== track.id) {
      element.src = api.streamUrl(track.id)
      element.preload = preloadFor(usePlayer.getState().playing)
      element.load()
      loadedTrackIds.current[slot] = track.id
    }
    let cancelled = false
    let release: (() => void) | undefined

    new StreamFirstSourceResolver(api).resolve(track).then((source) => {
      if (cancelled) { source.revoke?.(); return }
      release = source.revoke
      if (activeSlot.current !== slot || loadedTrackIds.current[slot] !== track.id) return
      if (element.src !== source.url) {
        element.src = source.url
        element.preload = preloadFor(usePlayer.getState().playing)
        element.load()
      }
      if (usePlayer.getState().playing && element.paused) playElement(element, slot)
    })

    return () => {
      cancelled = true
      release?.()
    }
  }, [api, track?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep one complete track primed ahead. The current element can then hand off
  // to an already-buffering decoder instead of loading the next URL after ended.
  useEffect(() => {
    if (!track || !playing || shuffle || repeat === 'one' || queue.length < 2) return

    let nextIndex = currentIndex + 1
    if (nextIndex >= queue.length) {
      if (repeat !== 'all') return
      nextIndex = 0
    }

    const nextTrack = queue[nextIndex]
    if (!nextTrack || nextTrack.id === track.id) return

    const slot = (activeSlot.current === 0 ? 1 : 0) as AudioSlot
    const element = getAudio(slot)
    if (!element || loadedTrackIds.current[slot] === nextTrack.id) return

    if (!element.paused) element.pause()
    element.src = api.streamUrl(nextTrack.id)
    element.preload = 'auto'
    element.load()
    element.volume = volume
    element.muted = muted
    loadedTrackIds.current[slot] = nextTrack.id
  }, [api, currentIndex, muted, playing, queue, repeat, shuffle, track?.id, volume]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const element = currentAudio()
    if (!element || !track) return
    if (playing) {
      element.preload = 'auto'
      if (element.paused) playElement(element, activeSlot.current)
    } else {
      clearRetry()
      clearStall()
      pauseAll()
    }
  }, [playing, track]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const slot of [0, 1] as const) {
      const element = getAudio(slot)
      if (element) {
        element.volume = volume
        element.muted = muted
      }
    }
  }, [volume, muted])

  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => usePlayer.getState().setPlaying(true)],
      ['pause', () => usePlayer.getState().setPlaying(false)],
      ['previoustrack', () => usePlayer.getState().previous()],
      ['nexttrack', () => usePlayer.getState().next()],
      ['seekbackward', (d) => usePlayer.getState().seekTo(Math.max(0, (currentAudio()?.currentTime ?? 0) - (d.seekOffset ?? 10)))],
      ['seekforward', (d) => usePlayer.getState().seekTo(Math.min(currentAudio()?.duration ?? Infinity, (currentAudio()?.currentTime ?? 0) + (d.seekOffset ?? 10)))],
      ['seekto', (d) => d.seekTime !== undefined && usePlayer.getState().seekTo(d.seekTime)],
    ]
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported action on this browser */ } })
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null) } catch { /* unsupported action */ } })
  }, [api, track])

  useEffect(() => {
    if (track && 'mediaSession' in navigator) setMediaMetadata(track, api)
  }, [api, track, artworkOverride])

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  }, [playing])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const bus = new BroadcastChannel(PLAYER_CHANNEL)
    channel.current = bus
    bus.onmessage = (event: MessageEvent<{ type?: string; id?: string }>) => {
      if (event.data?.type !== 'playing' || event.data.id === instanceId.current) return
      clearRetry()
      clearStall()
      pauseAll()
      if (usePlayer.getState().playing) usePlayer.setState({ playing: false })
    }
    return () => {
      channel.current = null
      bus.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When the connection comes back, retry straight away instead of waiting out the back-off.
  useEffect(() => {
    const online = () => {
      const element = currentAudio()
      if (!element || !usePlayer.getState().playing) return
      if (!element.error && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
      clearRetry()
      retries.current = 0
      recover(activeSlot.current)
    }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const events = (slot: AudioSlot) => ({
    onTimeUpdate: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current !== slot) return
      const element = event.currentTarget
      const duration = Number.isFinite(element.duration) ? element.duration : track?.duration ?? 0
      const pending = initialRestore.current
      if (track && pending?.trackId === track.id && pending.position > 0 && restoredPositionTrackId.current !== track.id) return
      if (resumeAt.current?.slot === slot) return
      usePlayer.getState().setProgress(element.currentTime, duration)
      if (track && duration > 0 && element.currentTime >= Math.min(duration / 2, 240) && submittedTrackId.current !== track.id) {
        submittedTrackId.current = track.id
        void api.scrobble(track.id, true).catch(() => { if (submittedTrackId.current === track.id) submittedTrackId.current = undefined })
      }
      if ('mediaSession' in navigator && Number.isFinite(element.duration) && element.duration > 0) {
        try { navigator.mediaSession.setPositionState({ duration: element.duration, playbackRate: element.playbackRate, position: Math.min(element.currentTime, element.duration) }) } catch { /* browser rejected position update */ }
      }
    },
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current !== slot) return
      const element = event.currentTarget
      const resume = resumeAt.current
      if (resume?.slot === slot) {
        resumeAt.current = null
        if (track?.id === resume.trackId && Number.isFinite(element.duration)) {
          element.currentTime = Math.min(resume.position, Math.max(0, element.duration - 0.05))
        }
        usePlayer.getState().setProgress(element.currentTime, element.duration)
        return
      }
      const player = usePlayer.getState()
      const pending = initialRestore.current
      const wantedPosition = track && pending?.trackId === track.id ? pending.position : player.currentTime
      if (track && restoredPositionTrackId.current !== track.id && wantedPosition > 0 && Number.isFinite(element.duration)) {
        element.currentTime = Math.min(wantedPosition, Math.max(0, element.duration - 0.05))
        restoredPositionTrackId.current = track.id
        initialRestore.current = null
      }
      usePlayer.getState().setProgress(element.currentTime, element.duration)
    },
    onPlaying: () => {
      if (activeSlot.current !== slot) return
      retries.current = 0
      clearStall()
    },
    onWaiting: () => watchForStall(slot),
    onStalled: () => watchForStall(slot),
    onPlay: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      // The pre-loaded next track must stay silent until it is handed over. If
      // anything (the OS resuming audio, a stale play request) starts it, stop it.
      if (activeSlot.current !== slot) {
        event.currentTarget.pause()
        return
      }
      channel.current?.postMessage({ type: 'playing', id: instanceId.current })
      if (!usePlayer.getState().playing) usePlayer.setState({ playing: true })
    },
    onPause: () => {
      if (activeSlot.current === slot && usePlayer.getState().playing) usePlayer.setState({ playing: false })
    },
    onEnded: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current !== slot) return
      if (track && submittedTrackId.current !== track.id) {
        submittedTrackId.current = track.id
        void api.scrobble(track.id, true).catch(() => undefined)
      }
      if (usePlayer.getState().repeat === 'one') {
        submittedTrackId.current = undefined
        if (track) void api.scrobble(track.id, false).catch(() => undefined)
        event.currentTarget.currentTime = 0
        void event.currentTarget.play()
      } else {
        usePlayer.getState().next()
      }
    },
    onError: () => recover(slot),
  })

  return <>
    <audio ref={audioA} preload="metadata" playsInline {...events(0)}/>
    <audio ref={audioB} preload="metadata" playsInline {...events(1)}/>
  </>
}
