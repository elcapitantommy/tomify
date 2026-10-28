import { useEffect, useRef } from 'react'
import { useApi } from '../lib/api-context'
import { LocalFirstSourceResolver } from '../lib/sourceResolver'
import { cachedLocalAudioUrl, localAudioUrl } from '../lib/offline-db'
import { bindPlayerRuntime, usePlayer } from '../stores/player'
import { setMediaMetadata } from '../lib/mediaSession'
import { ListeningTracker, sendListeningEvent } from '../lib/listening-log'
import { localPlaybackDeviceName } from '../stores/livePlayback'
import { albumArtworkUrl, useAlbumArtwork } from '../stores/albumArtwork'
import { OUTPUT_DROP_AFTER_PLAY_MS, watchAudioOutputs, type AudioOutputWatcher } from '../lib/audioOutputs'
import { logPlayback } from '../lib/playbackLog'
import { ADAPTIVE_START_TIMEOUT_MS, RETRY_DELAYS_MS, STALL_TIMEOUT_MS } from '../lib/playbackRecovery'
import { AdaptiveSources, chooseSource, loadHlsLibrary, markAdaptiveUnavailable, playbackEngine, wantsAdaptive, type StreamSource } from '../lib/adaptiveStream'
import { castElementState, castErrorMessage, castKind, type CastableElement, type CastState } from '../lib/cast'
import { bindCastPrompt, useCast } from '../stores/cast'
import { isLanUrl, mediaStreamFailed } from '../lib/mediaRoute'
import { useStreamQuality } from '../stores/streamQuality'
import { useEqualiser } from '../stores/equaliser'
import { EqualiserGraph, equaliserSupported, setActiveGraph } from '../lib/equaliser'
import { useVisualiser } from '../stores/visualiser'
import { useNormalisation } from '../stores/normalisation'
import { useDj } from '../stores/dj'
import { gainModeAt, originalVolumeScale, queueIndexOf, streamGainMode } from '../lib/loudness'
import { crossfadeSeconds, fadeInLevel, fadeOutLevel, GAPLESS_LEAD_SECONDS, volumeCanFade } from '../lib/crossfade'
import { sleepsAtTrackEnd, takeTrackEnd } from '../stores/sleepTimer'
import { MAX_CROSSFADE_SECONDS, useCrossfade } from '../stores/crossfade'
import type { PlayerState } from '../stores/player'
import type { Track } from '../types'

type AudioSlot = 0 | 1
const otherSlot = (slot: AudioSlot) => (slot === 0 ? 1 : 0) as AudioSlot

// The song that plays when the current one ends, if any.
function upcomingTrack(state: Pick<PlayerState, 'queue' | 'currentIndex' | 'repeat'>): Track | undefined {
  if (state.repeat === 'one' || state.queue.length < 2) return undefined
  let index = state.currentIndex + 1
  if (index >= state.queue.length) {
    if (state.repeat !== 'all') return undefined
    index = 0
  }
  const next = state.queue[index]
  return next && next.id !== state.queue[state.currentIndex]?.id ? next : undefined
}

const FADE_STEP_MS = 50

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
  const listening = useRef(new ListeningTracker())
  const resumeAt = useRef<{ slot: AudioSlot; trackId: string; position: number } | null>(null)
  // A reload's seek back to where it was, checked again once the stream can play (iPhone can drop a seek made too early).
  const resumeCheck = useRef<{ slot: AudioSlot; trackId: string; position: number } | null>(null)
  const retries = useRef(0)
  const retryTimer = useRef<number | undefined>(undefined)
  const stallTimer = useRef<number | undefined>(undefined)
  const instanceId = useRef(newInstanceId())
  const channel = useRef<BroadcastChannel | null>(null)
  const sources = useRef(new AdaptiveSources())
  const equaliser = useRef<EqualiserGraph | null>(null)
  // Loudness normalisation for each element: what the listener's volume is multiplied by. Adaptive
  // streams arrive normalised, so theirs is 1; an original file is turned down by its ReplayGain.
  const volumeScale = useRef<[number, number]>([1, 1])
  // Crossfade and gapless (lib/crossfade.ts): near the end of a song the next one, already loaded in the other
  // element, is started early. `fadeLevel` multiplies each element's volume while the two overlap.
  const fadeLevel = useRef<[number, number]>([1, 1])
  const handoffTimer = useRef<number | undefined>(undefined)
  const handingOff = useRef<{ from: AudioSlot; seconds: number } | null>(null)
  const fade = useRef<{ from: AudioSlot; to: AudioSlot; timer: number } | null>(null)
  const canFade = useRef<boolean | null>(null)
  const outputs = useRef<AudioOutputWatcher | null>(null)
  // When the lock screen, headphones or car last asked to play (see the media session handlers).
  const sessionPlayAt = useRef(-Infinity)
  // The element playing on a speaker or TV (lib/cast.ts). While set, every song plays on it, as an original file.
  const castSlot = useRef<AudioSlot | null>(null)
  const api = useApi()
  const queue = usePlayer((s) => s.queue)
  const currentIndex = usePlayer((s) => s.currentIndex)
  const playing = usePlayer((s) => s.playing)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const repeat = usePlayer((s) => s.repeat)
  const equaliserEnabled = useEqualiser((s) => s.enabled)
  const equaliserGains = useEqualiser((s) => s.gains)
  const visualiserOn = useVisualiser((s) => s.mode !== 'off')
  const normalisation = useNormalisation((s) => s.setting)
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
    clearHandoff()
  }, [track?.id])

  // Listening history for mixes: a play ends when the track changes (or the page closes), and only
  // starts once the track actually plays, so restoring a paused queue doesn't count as a play.
  useEffect(() => {
    const tracker = listening.current
    if (tracker.trackId && tracker.trackId !== track?.id) void sendListeningEvent(tracker.finish(false, localPlaybackDeviceName))
    if (track && playing) tracker.begin(track)
  }, [track, playing])

  useEffect(() => {
    const onPageHide = () => void sendListeningEvent(listening.current.finish(false, localPlaybackDeviceName))
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  useEffect(() => () => {
    clearRetry()
    clearStall()
    clearHandoff()
    if (fade.current) window.clearInterval(fade.current.timer)
    for (const slot of [0, 1] as const) { const element = getAudio(slot); if (element) sources.current.detach(element) }
  }, [])

  // Short-lived media tokens and LAN-direct streaming, when the Worker offers them (lib/mediaRoute.ts).
  useEffect(() => api.startMediaSessions(), [api])

  // Fetch the HLS player before the first track needs it, unless this device always streams originals.
  useEffect(() => { if (api.hlsUrl('warm-up') && wantsAdaptive(useStreamQuality.getState().quality)) void loadHlsLibrary() }, [api])

  // Tell Navidrome "now playing" only once the track actually plays, not when a page load restores a paused queue.
  useEffect(() => {
    if (!track || !playing || nowPlayingTrackId.current === track.id) return
    nowPlayingTrackId.current = track.id
    void api.scrobble(track.id, false).catch(() => undefined)
  }, [api, playing, track?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const getAudio = (slot: AudioSlot) => slot === 0 ? audioA.current : audioB.current
  const currentAudio = () => getAudio(activeSlot.current)

  // The ReplayGain mode for a track, from where it sits in the queue.
  function gainModeFor(wanted: Track) {
    const { queue: currentQueue, currentIndex: index } = usePlayer.getState()
    return gainModeAt(currentQueue, queueIndexOf(currentQueue, index, wanted), useNormalisation.getState().setting)
  }

  function sourceFor(element: HTMLAudioElement, wanted: Track): StreamSource {
    // A downloaded copy the resolver has already opened plays from the device, on every load (see lib/offline-db.ts).
    // A speaker fetches the song itself, so it gets the stream, never a copy only this device can open.
    const casting = castSlot.current !== null
    const local = casting ? null : cachedLocalAudioUrl(api.session, wanted.id)
    if (local) return { kind: 'direct', url: local }
    return chooseSource(element, { direct: api.streamUrl(wanted.id), hls: api.hlsUrl(wanted.id, streamGainMode(wanted, gainModeFor(wanted))) }, casting ? 'original' : useStreamQuality.getState().quality)
  }

  function applyVolume(slot: AudioSlot) {
    const element = getAudio(slot)
    if (!element) return
    const { volume: level, muted: isMuted } = usePlayer.getState()
    element.volume = Math.min(1, Math.max(0, level * volumeScale.current[slot] * fadeLevel.current[slot]))
    element.muted = isMuted
  }

  function refreshVolumeScale(slot: AudioSlot, wanted: Track) {
    const element = getAudio(slot)
    volumeScale.current[slot] = element && sources.current.kind(element) === 'direct' ? originalVolumeScale(wanted, gainModeFor(wanted)) : 1
    applyVolume(slot)
  }

  // Every track load goes through here, so a slot is either a plain stream or an HLS
  // player, never a stale mix of both.
  function loadInto(slot: AudioSlot, wanted: Track, preload: 'auto' | 'metadata', source?: StreamSource) {
    const element = getAudio(slot)
    if (!element) return
    const chosen = source ?? sourceFor(element, wanted)
    // The box on the home network is another origin; CORS keeps its audio readable by the equaliser.
    const cors = isLanUrl(chosen.url) ? 'anonymous' : null
    if (element.crossOrigin !== cors) element.crossOrigin = cors
    sources.current.attach(element, chosen, { preload, onFatal: (unavailable) => adaptiveFailed(slot, wanted.id, unavailable) })
    loadedTrackIds.current[slot] = wanted.id
    refreshVolumeScale(slot, wanted)
  }

  // hls.js gave up. If the box can't stream adaptively, switch to originals; if the signal
  // dropped, go through the normal reload-and-resume recovery.
  function adaptiveFailed(slot: AudioSlot, trackId: string, unavailable: boolean) {
    if (loadedTrackIds.current[slot] !== trackId) return
    const element = getAudio(slot)
    // On the home network a failure says nothing about adaptive streaming: retry it through the Worker.
    if (element && leftLan(element)) unavailable = false
    if (unavailable) markAdaptiveUnavailable()
    if (activeSlot.current === slot && usePlayer.getState().playing) {
      if (unavailable) { clearRetry(); retries.current = 0 }
      recover(slot)
      return
    }
    if (element) sources.current.detach(element)
    loadedTrackIds.current[slot] = undefined
  }

  // A stream straight from the box failed (left home, box restarting): later loads go through the Worker.
  function leftLan(element: HTMLAudioElement) { return mediaStreamFailed(sources.current.url(element)) }

  function pauseAll() {
    clearHandoff()
    stopFade(false)
    for (const slot of [0, 1] as const) {
      const element = getAudio(slot)
      if (element && !element.paused) element.pause()
    }
  }

  function clearHandoff() {
    if (handoffTimer.current !== undefined) window.clearTimeout(handoffTimer.current)
    handoffTimer.current = undefined
  }

  // Called as the current song plays: in its last moments, set a timer to start the next one early, by the
  // crossfade length or, gapless, just enough to cover the time the next element takes to start.
  function scheduleHandoff(element: HTMLAudioElement, slot: AudioSlot) {
    if (handoffTimer.current !== undefined || element.paused || !Number.isFinite(element.duration)) return
    const remaining = element.duration - element.currentTime
    if (remaining > MAX_CROSSFADE_SECONDS + 1) return
    const state = usePlayer.getState()
    const current = state.queue[state.currentIndex]
    const upcoming = upcomingTrack(state)
    if (!current || !upcoming || !state.playing) return
    // The sleep timer is waiting for this song to end, so nothing starts early.
    if (sleepsAtTrackEnd()) return
    if (canFade.current === null) canFade.current = volumeCanFade()
    const seconds = crossfadeSeconds(current, upcoming, useCrossfade.getState().seconds, { canFade: canFade.current, dj: useDj.getState().active })
    const lead = Math.max(seconds, GAPLESS_LEAD_SECONDS)
    // Progress arrives about four times a second, so the timer is set within the last second before the hand-over.
    if (remaining > lead + 1) return
    handoffTimer.current = window.setTimeout(() => handOff(slot, current, upcoming.id, seconds, lead), Math.max(0, (remaining - lead) * 1000))
  }

  function handOff(slot: AudioSlot, current: Track, nextId: string, seconds: number, lead: number) {
    handoffTimer.current = undefined
    const state = usePlayer.getState()
    const element = getAudio(slot)
    const standby = getAudio(otherSlot(slot))
    if (!state.playing || activeSlot.current !== slot || state.queue[state.currentIndex]?.id !== current.id || upcomingTrack(state)?.id !== nextId) return
    if (!element || element.paused || element.duration - element.currentTime > lead + 0.5) return
    if (sleepsAtTrackEnd()) return
    // Only a next song that can start at once takes over early; otherwise it starts when this one ends, as before.
    if (!standby || loadedTrackIds.current[otherSlot(slot)] !== nextId || standby.error || standby.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    finishPlay(current)
    handingOff.current = { from: slot, seconds }
    try { state.next() } finally { handingOff.current = null }
  }

  // The song handed over from keeps playing to its end (gapless) or fades out while the next fades in.
  function beginFade(from: AudioSlot, to: AudioSlot, seconds: number) {
    stopFade(false)
    const total = Math.max(seconds, 0.5) * 1000
    const startedAt = Date.now()
    const step = () => {
      const progress = (Date.now() - startedAt) / total
      const element = getAudio(from)
      if (progress >= 1 || !element || element.paused || element.ended) { stopFade(true); return }
      if (seconds > 0) {
        fadeLevel.current[from] = fadeOutLevel(progress)
        fadeLevel.current[to] = fadeInLevel(progress)
        applyVolume(from)
        applyVolume(to)
      }
    }
    fade.current = { from, to, timer: window.setInterval(step, FADE_STEP_MS) }
    if (seconds > 0) { fadeLevel.current[to] = 0; applyVolume(to) }
  }

  function stopFade(finished: boolean) {
    const running = fade.current
    if (!running) return
    window.clearInterval(running.timer)
    fade.current = null
    const element = getAudio(running.from)
    if (element && !element.paused) element.pause()
    fadeLevel.current = [1, 1]
    applyVolume(0)
    applyVolume(1)
    // The element faded out is free again: load the song after this one into it.
    if (finished) primeNext()
  }

  // A song that played to its end (or was handed over from in its last seconds) counts as finished.
  function finishPlay(finished: Track) {
    if (listening.current.trackId === finished.id) {
      void sendListeningEvent(listening.current.finish(true, localPlaybackDeviceName))
      if (usePlayer.getState().repeat === 'one') listening.current.begin(finished)
    }
    if (submittedTrackId.current !== finished.id) {
      submittedTrackId.current = finished.id
      void api.scrobble(finished.id, true).catch(() => undefined)
    }
  }

  // Keep one complete track primed ahead. The current element can then hand off
  // to an already-buffering decoder instead of loading the next URL after ended.
  function primeNext() {
    const state = usePlayer.getState()
    // Casting keeps to one element, so there is no second one to prime (and no crossfade).
    if (!state.playing || castSlot.current !== null) return
    const nextTrack = upcomingTrack(state)
    const slot = otherSlot(activeSlot.current)
    const element = getAudio(slot)
    if (!nextTrack || !element || loadedTrackIds.current[slot] === nextTrack.id || fade.current?.from === slot) return
    if (!element.paused) element.pause()
    loadInto(slot, nextTrack, 'auto')
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
    // A broken or stuck adaptive stream retries as the original file. hls.js already rides out
    // a weak signal on its own, so reaching this point means HLS itself isn't working here.
    if (!leftLan(element) && sources.current.kind(element) === 'hls') markAdaptiveUnavailable()
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
      loadInto(slot, wanted, 'auto')
      playElement(element, slot)
    }, delay)
  }

  // play() is rejected with AbortError whenever a newer load() interrupts it;
  // that is not a failure. A blocked autoplay pauses; anything else is a broken
  // source and goes through recovery.
  function playElement(element: HTMLAudioElement, slot: AudioSlot) {
    equaliser.current?.resume()
    sources.current.startLoading(element)
    // Safari's own HLS player can sit silent without reporting an error; give an adaptive
    // stream a few seconds to start before switching to the original file.
    if (sources.current.kind(element) === 'hls') watchForStall(slot, ADAPTIVE_START_TIMEOUT_MS)
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

  // The car and lock screen move their own progress bar on from the last
  // position while they think audio is playing. When the stream runs dry, tell
  // them it has stopped, so they don't show progress over silence.
  function reportToLockScreen(element: HTMLAudioElement, audible: boolean) {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = audible ? 'playing' : 'paused'
    if (!Number.isFinite(element.duration) || element.duration <= 0) return
    try { navigator.mediaSession.setPositionState({ duration: element.duration, playbackRate: element.playbackRate || 1, position: Math.min(element.currentTime, element.duration) }) } catch { /* browser rejected position update */ }
  }

  function buffering(element: HTMLAudioElement, slot: AudioSlot) {
    if (activeSlot.current !== slot || !usePlayer.getState().playing) return
    reportToLockScreen(element, false)
    watchForStall(slot)
  }

  // A stream only counts as stuck if it hasn't moved on by the time the watchdog fires. Safari
  // reports 'stalled' while an adaptive stream plays on happily from what it has buffered.
  function watchForStall(slot: AudioSlot, timeout = STALL_TIMEOUT_MS) {
    if (activeSlot.current !== slot || !usePlayer.getState().playing || stallTimer.current !== undefined) return
    const startedAt = getAudio(slot)?.currentTime ?? 0
    stallTimer.current = window.setTimeout(() => {
      stallTimer.current = undefined
      if (activeSlot.current !== slot || !usePlayer.getState().playing) return
      const element = getAudio(slot)
      if (element && !element.paused && !element.error && element.currentTime >= startedAt + 1) return
      recover(slot)
    }, timeout)
  }

  function confirmResume(element: HTMLAudioElement, slot: AudioSlot) {
    const check = resumeCheck.current
    if (!check || check.slot !== slot) return
    resumeCheck.current = null
    if (track?.id !== check.trackId || !Number.isFinite(element.duration)) return
    if (element.currentTime < check.position - 2) element.currentTime = Math.min(check.position, Math.max(0, element.duration - 0.05))
  }

  useEffect(() => bindPlayerRuntime({
    seek: (value) => {
      clearHandoff()
      const element = currentAudio()
      if (element) element.currentTime = value
    },
    volume: (value, isMuted) => {
      for (const slot of [0, 1] as const) {
        const element = getAudio(slot)
        if (element) {
          element.volume = Math.min(1, Math.max(0, value * volumeScale.current[slot] * fadeLevel.current[slot]))
          element.muted = isMuted
        }
      }
    },
    start: (nextTrack: Track) => {
      const current = activeSlot.current
      const standby = (current === 0 ? 1 : 0) as AudioSlot
      let target = current

      if (castSlot.current === null && loadedTrackIds.current[current] !== nextTrack.id && loadedTrackIds.current[standby] === nextTrack.id && !getAudio(standby)?.error) {
        activeSlot.current = standby
        target = standby
      }
      // Only one element may be heard, except while a song hands over to the next one (crossfade or gapless).
      const handoff = handingOff.current
      if (handoff && handoff.from === otherSlot(target)) beginFade(handoff.from, target, handoff.seconds)
      else {
        stopFade(false)
        const other = getAudio(otherSlot(target))
        if (other && !other.paused) other.pause()
      }

      const element = getAudio(target)
      if (!element) return

      const source = sourceFor(element, nextTrack)
      const trackChanged = loadedTrackIds.current[target] !== nextTrack.id
      if (trackChanged || !sources.current.matches(element, source) || element.error) loadInto(target, nextTrack, 'auto', source)
      element.preload = 'auto'

      if (element.ended) element.currentTime = 0

      // Something can hold the new track before it starts (the DJ talking first); the playing effect starts it later.
      if (!usePlayer.getState().playing) return
      playElement(element, target)
    },
  }), [api]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!track) return
    const slot = activeSlot.current
    const element = getAudio(slot)
    if (!element) return
    if (loadedTrackIds.current[slot] !== track.id) loadInto(slot, track, preloadFor(usePlayer.getState().playing))
    let cancelled = false
    let release: (() => void) | undefined

    new LocalFirstSourceResolver(api).resolve(track).then((source) => {
      if (cancelled) { source.revoke?.(); return }
      release = source.revoke
      if (activeSlot.current !== slot || loadedTrackIds.current[slot] !== track.id) return
      const wanted: StreamSource = source.kind === 'local' && castSlot.current === null ? { kind: 'direct', url: source.url } : sourceFor(element, track)
      if (!sources.current.matches(element, wanted)) {
        // Switching a playing stream to its downloaded copy carries on from the same spot.
        if (source.kind === 'local' && element.currentTime > 0) resumeAt.current = { slot, trackId: track.id, position: element.currentTime }
        loadInto(slot, track, preloadFor(usePlayer.getState().playing), wanted)
      }
      if (usePlayer.getState().playing && element.paused) playElement(element, slot)
    })

    return () => {
      cancelled = true
      release?.()
    }
  }, [api, track?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow AirPlay / Cast on both elements: the one sent to a speaker becomes the only one used until it comes back.
  useEffect(() => {
    const elements = ([0, 1] as const).map((slot) => getAudio(slot) as CastableElement | null)
    const kind = castKind(elements[0])
    useCast.getState().set({ kind })
    if (!kind) return
    const update = () => {
      let slot: AudioSlot | null = null
      let state: CastState = 'disconnected'
      for (const candidate of [0, 1] as const) {
        const element = elements[candidate]
        const current = element ? castElementState(element, kind) : 'disconnected'
        if (current !== 'disconnected') { slot = candidate; state = current; break }
      }
      const was = castSlot.current
      castSlot.current = slot
      useCast.getState().set({ state, ...(state === 'connected' ? { error: null } : {}) })
      if (slot !== null && was === null) {
        // The song primed on the other element would play here, not on the speaker: forget it.
        const standby = getAudio(otherSlot(slot))
        clearHandoff()
        if (standby && !standby.paused) standby.pause()
        loadedTrackIds.current[otherSlot(slot)] = undefined
        activeSlot.current = slot
      }
      if (slot === null && was !== null) primeNext()
    }
    const events = kind === 'airplay' ? ['webkitcurrentplaybacktargetiswirelesschanged'] : ['connecting', 'connect', 'disconnect']
    const targets: EventTarget[] = []
    for (const element of elements) { const target = kind === 'airplay' ? element : element?.remote; if (target) targets.push(target as EventTarget) }
    targets.forEach((target) => events.forEach((name) => target.addEventListener(name, update)))
    update()
    return () => targets.forEach((target) => events.forEach((name) => target.removeEventListener(name, update)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The player bar's AirPlay / Cast button. It runs inside the click, as browsers require for their picker.
  useEffect(() => bindCastPrompt(() => {
    const slot = activeSlot.current
    const element = getAudio(slot)
    const castable = element as CastableElement | null
    const kind = castKind(castable)
    if (!element || !castable || !kind) return
    useCast.getState().set({ error: null })
    if (kind === 'airplay') { castable.webkitShowPlaybackTargetPicker?.(); return }
    // A stream hls.js builds in the browser, or a downloaded copy, can't be sent: switch this song to its
    // original file at the same spot first.
    const state = usePlayer.getState()
    const wanted = state.queue[state.currentIndex]
    const unsendable = (sources.current.kind(element) === 'hls' && playbackEngine(element) === 'hls.js') || (sources.current.url(element) ?? '').startsWith('blob:')
    if (wanted && unsendable) {
      if (element.currentTime > 0) resumeAt.current = { slot, trackId: wanted.id, position: element.currentTime }
      loadInto(slot, wanted, 'auto', { kind: 'direct', url: api.streamUrl(wanted.id) })
      if (state.playing) playElement(element, slot)
    }
    castable.remote?.prompt().catch((error: unknown) => useCast.getState().set({ error: castErrorMessage(error) }))
  }), [api]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (track && playing) primeNext()
  }, [api, currentIndex, muted, playing, queue, repeat, track?.id, volume]) // eslint-disable-line react-hooks/exhaustive-deps

  // Downloaded songs coming up are opened early, so a next track pre-loaded as a stream switches to the copy on the device.
  useEffect(() => {
    let cancelled = false
    queue.slice(currentIndex + 1, currentIndex + 3).forEach((upcoming) => void localAudioUrl(api.session, upcoming.id).then((url) => {
      const slot = (activeSlot.current === 0 ? 1 : 0) as AudioSlot
      const element = getAudio(slot)
      if (!url || cancelled || !element || loadedTrackIds.current[slot] !== upcoming.id) return
      const local: StreamSource = { kind: 'direct', url }
      if (!sources.current.matches(element, local)) loadInto(slot, upcoming, 'auto', local)
    }))
    return () => { cancelled = true }
  }, [api, queue, currentIndex]) // eslint-disable-line react-hooks/exhaustive-deps

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
    for (const slot of [0, 1] as const) applyVolume(slot)
  }, [volume, muted]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new normalisation setting turns original files up or down straight away; an adaptive
  // stream takes it from the next track, like a new streaming quality.
  useEffect(() => {
    const { queue: currentQueue } = usePlayer.getState()
    for (const slot of [0, 1] as const) {
      const loaded = currentQueue.find((candidate) => candidate.id === loadedTrackIds.current[slot])
      if (loaded) refreshVolumeScale(slot, loaded)
    }
  }, [normalisation, queue]) // eslint-disable-line react-hooks/exhaustive-deps

  // Both elements go through the equaliser from the first time it or the visualiser is switched on (see lib/equaliser.ts).
  useEffect(() => {
    if ((equaliserEnabled || visualiserOn) && !equaliser.current && equaliserSupported() && api.streamsSameOrigin()) {
      const graph = new EqualiserGraph()
      if (graph.attach([audioA.current, audioB.current].filter((element): element is HTMLAudioElement => element !== null))) {
        equaliser.current = graph
        setActiveGraph(graph)
      }
    }
    equaliser.current?.apply(equaliserGains, equaliserEnabled)
    if (usePlayer.getState().playing) equaliser.current?.resume()
  }, [api, equaliserEnabled, equaliserGains, visualiserOn])

  // True when the music is paused and an audio device has just connected or dropped out.
  function outputJustChanged() {
    return !usePlayer.getState().playing && Boolean(outputs.current?.changedRecently())
  }

  function skipFromSession(direction: 'next' | 'previous') {
    if (outputJustChanged()) { logPlayback(`Ignored ${direction}`, 'an audio device had just come or gone'); return }
    const wasPaused = !usePlayer.getState().playing
    logPlayback(direction === 'next' ? 'Next' : 'Previous', 'lock screen, headphones or car')
    if (direction === 'next') usePlayer.getState().next()
    else usePlayer.getState().previous()
    // A skip that started paused music is undone like a play if the device drops out straight after.
    if (wasPaused && usePlayer.getState().playing) sessionPlayAt.current = Date.now()
  }

  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => {
        // Headphones or a car dropping out can send a play of their own as they go: that would start the
        // music out of the speaker, so a play right as an audio device comes or goes is ignored.
        if (outputJustChanged()) { logPlayback('Ignored play', 'an audio device had just come or gone'); return }
        logPlayback('Play', 'lock screen, headphones or car')
        sessionPlayAt.current = Date.now()
        usePlayer.getState().setPlaying(true)
      }],
      ['pause', () => { logPlayback('Pause', 'lock screen, headphones or car'); useDj.getState().hush(); usePlayer.getState().setPlaying(false) }],
      // Skipping starts paused music too, so the same goes for a skip sent as headphones drop out.
      ['previoustrack', () => skipFromSession('previous')],
      ['nexttrack', () => skipFromSession('next')],
      ['seekbackward', (d) => usePlayer.getState().seekTo(Math.max(0, (currentAudio()?.currentTime ?? 0) - (d.seekOffset ?? 10)))],
      ['seekforward', (d) => usePlayer.getState().seekTo(Math.min(currentAudio()?.duration ?? Infinity, (currentAudio()?.currentTime ?? 0) + (d.seekOffset ?? 10)))],
      ['seekto', (d) => d.seekTime !== undefined && usePlayer.getState().seekTo(d.seekTime)],
    ]
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported action on this browser */ } })
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null) } catch { /* unsupported action */ } })
  }, [api, track]) // eslint-disable-line react-hooks/exhaustive-deps

  // The play from headphones dropping out can also arrive just before the browser reports the device change:
  // undo a lock-screen or headphone play that close to it. A device that is known to have gone pauses the
  // music as unplugging wired headphones does.
  useEffect(() => {
    const watcher = watchAudioOutputs((removed) => {
      if (removed) logPlayback('Audio device removed')
      else logPlayback('Audio devices changed')
      if (!usePlayer.getState().playing) return
      if (!removed && Date.now() - sessionPlayAt.current >= OUTPUT_DROP_AFTER_PLAY_MS) return
      logPlayback('Paused', removed ? 'an audio device went away' : 'the play came as an audio device came or went')
      useDj.getState().hush()
      usePlayer.getState().setPlaying(false)
    })
    outputs.current = watcher
    return () => {
      outputs.current = null
      watcher.stop()
    }
  }, [])

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
      if (usePlayer.getState().playing) logPlayback('Paused', 'another open copy of Tomify started playing')
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
      if (track && listening.current.trackId === track.id) listening.current.progress(element.currentTime, duration, !element.paused)
      if (track && duration > 0 && element.currentTime >= Math.min(duration / 2, 240) && submittedTrackId.current !== track.id) {
        submittedTrackId.current = track.id
        void api.scrobble(track.id, true).catch(() => { if (submittedTrackId.current === track.id) submittedTrackId.current = undefined })
      }
      scheduleHandoff(element, slot)
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
          resumeCheck.current = resume
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
    onCanPlay: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current === slot) confirmResume(event.currentTarget, slot)
    },
    onPlaying: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (activeSlot.current !== slot) return
      confirmResume(event.currentTarget, slot)
      retries.current = 0
      clearStall()
      reportToLockScreen(event.currentTarget, usePlayer.getState().playing)
    },
    onWaiting: (event: React.SyntheticEvent<HTMLAudioElement>) => buffering(event.currentTarget, slot),
    // 'stalled' only means the download has paused; it matters only when playback has run out of audio.
    onStalled: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) buffering(event.currentTarget, slot)
    },
    onPlay: (event: React.SyntheticEvent<HTMLAudioElement>) => {
      // The pre-loaded next track must stay silent until it is handed over. If
      // anything (the OS resuming audio, a stale play request) starts it, stop it.
      if (activeSlot.current !== slot) {
        event.currentTarget.pause()
        return
      }
      // A play the player didn't ask for comes from the browser or the phone, typically resuming on its own
      // after headphones or a car disconnected and it paused. That would start the music out of the speaker
      // minutes later, so it is stopped. The listener's own play buttons (lock screen, headphones, car) go
      // through the media session handlers below, which set the player playing first.
      if (!usePlayer.getState().playing && 'mediaSession' in navigator) {
        logPlayback('Stopped a play Tomify didn\'t ask for', 'the phone or browser resumed it')
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
      if (track) finishPlay(track)
      if (takeTrackEnd()) {
        usePlayer.getState().next({ pause: true })
      } else if (usePlayer.getState().repeat === 'one') {
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
    <audio ref={audioA} preload="metadata" playsInline x-webkit-airplay="allow" {...events(0)}/>
    <audio ref={audioB} preload="metadata" playsInline x-webkit-airplay="allow" {...events(1)}/>
  </>
}
