import { useEffect, useRef } from 'react'
import { useApi } from '../lib/api-context'
import { StreamFirstSourceResolver } from '../lib/sourceResolver'
import { bindPlayerRuntime, usePlayer } from '../stores/player'
import { setMediaMetadata } from '../lib/mediaSession'
import type { Track } from '../types'

type AudioSlot = 0 | 1

export function PlayerRuntime() {
  const audioA = useRef<HTMLAudioElement>(null)
  const audioB = useRef<HTMLAudioElement>(null)
  const activeSlot = useRef<AudioSlot>(0)
  const loadedTrackIds = useRef<[string | undefined, string | undefined]>([undefined, undefined])
  const submittedTrackId = useRef<string | undefined>(undefined)
  const api = useApi()
  const queue = usePlayer((s) => s.queue)
  const currentIndex = usePlayer((s) => s.currentIndex)
  const playing = usePlayer((s) => s.playing)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const track = queue[currentIndex]

  useEffect(() => {
    submittedTrackId.current = undefined
    if (track) void api.scrobble(track.id, false).catch(() => undefined)
  }, [api, track?.id])

  const getAudio = (slot: AudioSlot) => slot === 0 ? audioA.current : audioB.current
  const currentAudio = () => getAudio(activeSlot.current)

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

      if (loadedTrackIds.current[current] !== nextTrack.id && loadedTrackIds.current[standby] === nextTrack.id) {
        activeSlot.current = standby
        target = standby
        const oldElement = getAudio(current)
        if (oldElement && !oldElement.paused) oldElement.pause()
      }

      const element = getAudio(target)
      if (!element) return

      const url = api.streamUrl(nextTrack.id)
      if (loadedTrackIds.current[target] !== nextTrack.id || element.src !== url) {
        element.src = url
        element.preload = 'auto'
        element.load()
        loadedTrackIds.current[target] = nextTrack.id
      }

      if (element.ended || element.currentTime > 0 && loadedTrackIds.current[target] === nextTrack.id && nextTrack.id !== track?.id) {
        element.currentTime = 0
      }

      const attempt = element.play()
      if (attempt) void attempt.catch(() => usePlayer.getState().setPlaying(false))
    },
  }), [api]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!track) return
    const slot = activeSlot.current
    const element = getAudio(slot)
    if (!element) return
    let cancelled = false
    let release: (() => void) | undefined

    new StreamFirstSourceResolver(api).resolve(track).then((source) => {
      if (cancelled) { source.revoke?.(); return }
      release = source.revoke
      if (activeSlot.current !== slot || loadedTrackIds.current[slot] !== track.id) return
      if (element.src !== source.url) {
        element.src = source.url
        element.preload = 'auto'
        element.load()
      }
      if (usePlayer.getState().playing && element.paused) {
        void element.play().catch(() => usePlayer.getState().setPlaying(false))
      }
    })

    return () => {
      cancelled = true
      release?.()
    }
  }, [api, track?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep one complete track primed ahead. The current element can then hand off
  // to an already-buffering decoder instead of loading the next URL after ended.
  useEffect(() => {
    if (!track || shuffle || repeat === 'one' || queue.length < 2) return

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
  }, [api, currentIndex, muted, queue, repeat, shuffle, track?.id, volume]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const element = currentAudio()
    if (!element || !track) return
    if (playing) {
      if (element.paused) void element.play().catch(() => usePlayer.getState().setPlaying(false))
    } else {
      element.pause()
    }
  }, [playing, track])

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
    setMediaMetadata(track, api)
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  }, [playing])

  const events = (slot: AudioSlot) => ({
    onTimeUpdate: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current !== slot) return
      const element = event.currentTarget
      const duration = Number.isFinite(element.duration) ? element.duration : track?.duration ?? 0
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
      if (activeSlot.current === slot) usePlayer.getState().setProgress(event.currentTarget.currentTime, event.currentTarget.duration)
    },
    onPlay: () => {
      if (activeSlot.current === slot && !usePlayer.getState().playing) usePlayer.setState({ playing: true })
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
    onError: () => {
      if (activeSlot.current === slot) usePlayer.getState().setPlaying(false)
    },
  })

  return <>
    <audio ref={audioA} preload="auto" playsInline {...events(0)}/>
    <audio ref={audioB} preload="auto" playsInline {...events(1)}/>
  </>
}
