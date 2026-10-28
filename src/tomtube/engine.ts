// TomTube's player: one <video> for watching and one <audio> for listening, never both at once.
//
// Background audio is the point of TomTube, so the audio path stands on its own: switching to audio
// notes the video's position, stops and empties the <video> (it is not kept running in the
// background), loads the video's AAC audio into the <audio> element and starts it there. iOS keeps an
// <audio> element playing with the screen locked and shows it on the lock screen through the Media
// Session API, with play/pause, next/previous and seeking, from headphones and Bluetooth too.
//
// Moving to the next queued video while the phone is locked: iOS lets a page that is already playing
// audio start the next source on the same element from its `ended` event, but it may suspend a page
// that has gone silent. So the next source is set and played synchronously inside `ended`, with no
// network request or await first (the URL is built locally; the server has already fetched the next
// track's audio). The experimental alternative plays the whole queue as one continuous HLS stream from
// the server, so nothing has to start at all between tracks. Neither can be proven from a desktop
// browser; see docs/TOMTUBE.md for the device tests.
import type { AuthSession } from '../lib/navidrome'
import { mediaUrl, queueStreamUrl, thumbnailUrl, tomtubeApi, type QueueTimeline, type TomTubeVideo } from './api'
import * as Q from './queue'
import { useTomTube, type PlaybackMode, type PlayerView } from './store'

export const STALL_TIMEOUT_MS = 15_000
export const RETRY_DELAYS_MS = [1000, 3000, 6000, 10_000, 15_000]
// After this many failed attempts on HLS, the single-file stream is tried instead.
const HLS_FAILURES_BEFORE_FILE = 2
const MAX_CONTINUOUS_TRACKS = 20

type Media = HTMLMediaElement

interface Deps {
  video: Media
  audio: Media
  session: () => AuthSession | null
  api?: Pick<typeof tomtubeApi, 'prefetch' | 'queueTimeline'>
  mediaSession?: MediaSession | null
  setTimeout?: (callback: () => void, ms: number) => number
  clearTimeout?: (id: number) => void
  now?: () => number
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

interface Continuous { ids: string[]; baseIndex: number; timeline: QueueTimeline['tracks'] | null }

export function supportsNativeHls(element: Pick<Media, 'canPlayType'>) {
  try { return element.canPlayType('application/vnd.apple.mpegurl') !== '' } catch { return false }
}

export class TomTubeEngine {
  private readonly video: Media
  private readonly audio: Media
  private readonly deps: Deps
  private pendingSeek: number | null = null
  private retries = 0
  private retryTimer: number | null = null
  private stallTimer: number | null = null
  private stallFrom = 0
  private hlsFailures = new Map<string, number>()
  private continuous: Continuous | null = null
  private lastPositionSave = 0
  private lastLockScreenUpdate = 0
  private playingSince = 0
  private cleanups: Array<() => void> = []

  constructor(deps: Deps) {
    this.deps = deps
    this.video = deps.video
    this.audio = deps.audio
    for (const element of [this.video, this.audio]) this.listen(element)
    this.setupMediaSession()
    const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined)
    const win = deps.window ?? (typeof window !== 'undefined' ? window : undefined)
    if (doc) {
      const visibility = () => this.visibilityChanged(doc.visibilityState)
      doc.addEventListener('visibilitychange', visibility)
      this.cleanups.push(() => doc.removeEventListener('visibilitychange', visibility))
    }
    if (win) {
      const online = () => this.cameOnline()
      win.addEventListener('online', online)
      this.cleanups.push(() => win.removeEventListener('online', online))
    }
  }

  destroy() {
    this.cleanups.forEach((cleanup) => cleanup())
    this.clearTimers()
  }

  // --- state -------------------------------------------------------------------------------------

  private get store() { return useTomTube.getState() }
  private get view() { return this.store.player }
  private set(view: Partial<PlayerView>) { this.store.setPlayer(view) }
  private get element(): Media { return this.view.mode === 'audio' ? this.audio : this.video }
  private now() { return this.deps.now?.() ?? Date.now() }
  private timeout(callback: () => void, ms: number) { return (this.deps.setTimeout ?? ((cb, delay) => window.setTimeout(cb, delay)))(callback, ms) }
  private cancel(id: number | null) { if (id !== null) (this.deps.clearTimeout ?? ((value) => window.clearTimeout(value)))(id) }

  current(): TomTubeVideo | null { return Q.current(this.store.queue) }

  // --- sources -----------------------------------------------------------------------------------

  private useHls(id: string, mode: PlaybackMode) {
    const { settings } = this.store
    if (mode === 'video' && settings.videoQuality === 'compatible') return false
    if (mode === 'audio' && settings.audioFormat === 'file') return false
    if ((this.hlsFailures.get(`${mode}:${id}`) ?? 0) >= HLS_FAILURES_BEFORE_FILE) return false
    return supportsNativeHls(mode === 'audio' ? this.audio : this.video)
  }

  private sourceFor(video: TomTubeVideo, mode: PlaybackMode) {
    const session = this.deps.session()
    if (!session) return null
    const hls = this.useHls(video.id, mode)
    const file = mode === 'audio' ? (hls ? 'audio.m3u8' : 'audio.m4a') : (hls ? 'master.m3u8' : 'progressive.mp4')
    return { url: mediaUrl(session, video.id, file), kind: hls ? 'hls' as const : 'file' as const }
  }

  private release(element: Media) {
    element.pause()
    if (element.getAttribute('src')) {
      element.removeAttribute('src')
      element.load()
    }
  }

  // Loads the current video into the element for `mode`, starting at `position`. Everything here is
  // synchronous, so it can run inside a media event or a tap and still be allowed to play.
  private load(position = 0, autoplay = this.view.playing) {
    const video = this.current()
    if (!video) return
    const mode = this.view.mode
    const element = mode === 'audio' ? this.audio : this.video
    this.release(mode === 'audio' ? this.video : this.audio)
    this.clearTimers()
    const continuous = mode === 'audio' && this.continuousIds()
    const session = this.deps.session()
    if (!session) return
    let url: string
    let source: 'hls' | 'file'
    if (continuous) {
      url = queueStreamUrl(session, continuous)
      source = 'hls'
      this.continuous = { ids: continuous, baseIndex: this.store.queue.index, timeline: null }
      void this.loadTimeline(this.continuous)
    } else {
      const chosen = this.sourceFor(video, mode)
      if (!chosen) return
      url = chosen.url
      source = chosen.kind
      this.continuous = null
    }
    this.pendingSeek = position > 0.5 ? position : null
    element.setAttribute('src', url)
    element.load()
    this.set({ status: 'loading', error: null, currentTime: position, duration: video.duration ?? 0, source, continuous: Boolean(continuous), playing: autoplay })
    this.updateMetadata(video)
    if (autoplay) this.start(element)
    if (mode === 'audio') this.prefetchAhead()
  }

  private start(element: Media) {
    const attempt = element.play()
    if (!attempt) return
    attempt.catch((error: unknown) => {
      const name = (error as { name?: string } | null)?.name
      if (name === 'AbortError' || element !== this.element) return
      // iOS refused to start without a tap (for example switching to audio after the screen locked):
      // stay ready, so the lock screen's play button starts it.
      if (name === 'NotAllowedError') { this.set({ playing: false, status: 'paused' }); return }
      this.recover()
    })
  }

  // The continuous stream covers the current video and what is queued after it, in audio mode only.
  private continuousIds(): string[] | null {
    const { settings, queue } = this.store
    if (!settings.continuousQueue || !supportsNativeHls(this.audio)) return null
    const ids = queue.items.slice(queue.index, queue.index + MAX_CONTINUOUS_TRACKS).map((item) => item.id)
    return ids.length > 1 ? ids : null
  }

  private async loadTimeline(target: Continuous) {
    const session = this.deps.session()
    if (!session || !this.deps.api) return
    try {
      const timeline = await this.deps.api.queueTimeline(session, target.ids)
      if (this.continuous === target) target.timeline = timeline.tracks
    } catch { /* positions fall back to the videos' own durations */ }
  }

  // Track offsets in the continuous stream: from the server's timeline, else from known durations.
  private offsets(target: Continuous) {
    if (target.timeline) return target.timeline
    let offset = 0
    return target.ids.map((id, index) => {
      const duration = this.store.queue.items[target.baseIndex + index]?.duration ?? 0
      const entry = { id, offset, duration }
      offset += duration
      return entry
    })
  }

  // Asks the server to fetch the next video's audio now, while the phone is awake.
  private prefetchAhead() {
    const session = this.deps.session()
    const following = Q.upcoming(this.store.queue)[0]
    if (session && following && this.deps.api) void this.deps.api.prefetch(session, following.id).catch(() => undefined)
  }

  // --- controls (call these from taps) -------------------------------------------------------------

  playVideo(video: TomTubeVideo, position = 0) {
    this.store.setQueue(Q.playNow(this.store.queue, video))
    this.startedCurrent()
    this.load(position, true)
  }

  playAt(index: number) {
    const queue = this.store.queue
    if (index === queue.index || !queue.items[index]) return
    if (this.continuous && this.jumpWithinContinuous(index)) return
    this.store.setQueue(Q.jumpTo(queue, index))
    this.startedCurrent()
    this.load(0, true)
  }

  resume() {
    const element = this.element
    if (!this.current()) return
    if (!element.getAttribute('src') || this.view.status === 'error') { this.set({ playing: true }); this.load(this.view.currentTime, true); return }
    this.set({ playing: true })
    if (this.view.status === 'ended') this.seek(0)
    this.start(element)
  }

  pause() {
    this.set({ playing: false, status: this.current() ? 'paused' : 'idle' })
    this.clearTimers()
    this.element.pause()
    if (this.deps.mediaSession) this.deps.mediaSession.playbackState = 'paused'
  }

  toggle() { if (this.view.playing) this.pause(); else this.resume() }

  // Position within the current video.
  seek(seconds: number) {
    const element = this.element
    const target = Math.max(0, seconds)
    const offset = this.continuousOffset()
    if (element.readyState >= 1) element.currentTime = target + offset
    else this.pendingSeek = target + offset
    this.set({ currentTime: target })
  }

  skipNext() {
    const following = Q.next(this.store.queue)
    if (!following) return
    if (this.continuous && this.jumpWithinContinuous(following.index)) return
    this.store.setQueue(following)
    this.startedCurrent()
    this.load(0, true)
  }

  skipPrevious() {
    if (this.view.currentTime > 5) { this.seek(0); return }
    const before = Q.previous(this.store.queue)
    if (!before) { this.seek(0); return }
    if (this.continuous && this.jumpWithinContinuous(before.index)) return
    this.store.setQueue(before)
    this.startedCurrent()
    this.load(0, true)
  }

  setMode(mode: PlaybackMode, { auto = false } = {}) {
    if (mode === this.view.mode) return
    const position = this.view.currentTime
    const playing = this.view.playing
    this.set({ mode, autoAudio: auto && mode === 'audio' })
    if (!this.current()) { this.release(mode === 'audio' ? this.video : this.audio); return }
    this.load(position, playing)
  }

  // The queue changed under a continuous stream: rebuild it from where the listener is.
  queueChanged() {
    if (!this.continuous || this.view.mode !== 'audio') { if (this.view.mode === 'audio') this.prefetchAhead(); return }
    const ids = this.continuousIds()
    if (ids && ids.join(',') === this.continuous.ids.join(',')) return
    this.load(this.view.currentTime, this.view.playing)
  }

  settingsChanged() {
    if (this.current() && this.element.getAttribute('src')) this.load(this.view.currentTime, this.view.playing)
  }

  // --- continuous stream ---------------------------------------------------------------------------

  private continuousOffset() {
    if (!this.continuous) return 0
    const track = this.offsets(this.continuous)[this.store.queue.index - this.continuous.baseIndex]
    return track?.offset ?? 0
  }

  private jumpWithinContinuous(index: number) {
    const target = this.continuous!
    const track = this.offsets(target)[index - target.baseIndex]
    if (!track) return false
    this.store.setQueue(Q.jumpTo(this.store.queue, index))
    this.startedCurrent()
    this.audio.currentTime = track.offset
    this.set({ currentTime: 0, duration: track.duration })
    if (!this.view.playing) this.resume()
    return true
  }

  // Which track of the continuous stream is playing, from the element's position.
  private followContinuous(time: number) {
    const target = this.continuous!
    const tracks = this.offsets(target)
    let position = 0
    for (let index = 0; index < tracks.length; index += 1) if (time >= tracks[index].offset - 0.25) position = index
    const index = target.baseIndex + position
    if (index !== this.store.queue.index && this.store.queue.items[index]?.id === tracks[position].id) {
      this.store.setQueue(Q.jumpTo(this.store.queue, index))
      this.startedCurrent()
    }
    return { time: Math.max(0, time - tracks[position].offset), duration: tracks[position].duration }
  }

  // --- events --------------------------------------------------------------------------------------

  private listen(element: Media) {
    const active = () => element === this.element
    const on = (type: string, handler: () => void) => {
      const wrapped = () => { if (active()) handler() }
      element.addEventListener(type, wrapped)
      this.cleanups.push(() => element.removeEventListener(type, wrapped))
    }
    on('loadedmetadata', () => {
      if (this.pendingSeek !== null) {
        try { element.currentTime = this.pendingSeek } catch { /* applied on the next attempt */ }
        this.pendingSeek = null
      }
      if (!this.continuous && Number.isFinite(element.duration) && element.duration > 0) this.set({ duration: element.duration })
    })
    on('timeupdate', () => this.timeUpdate(element))
    on('playing', () => {
      this.retries = 0
      this.playingSince = this.now()
      this.clearStall()
      this.set({ status: 'playing', playing: true, error: null })
      if (this.deps.mediaSession) this.deps.mediaSession.playbackState = 'playing'
    })
    on('pause', () => {
      if (element.ended) return
      // A pause nobody here asked for: a phone call, Siri, headphones unplugged, or iOS pausing a video
      // for the lock screen. The lock screen's play button resumes it.
      if (this.view.playing && !(this.view.mode === 'video' && this.hiddenRecently())) this.set({ playing: false, status: 'paused' })
      if (this.deps.mediaSession) this.deps.mediaSession.playbackState = 'paused'
    })
    on('waiting', () => this.buffering(element))
    on('stalled', () => { if (element.readyState < 3) this.buffering(element) })
    on('ended', () => this.ended())
    on('error', () => this.recover())
  }

  private hiddenAt = 0
  private hiddenRecently() { return this.now() - this.hiddenAt < 1500 }

  private timeUpdate(element: Media) {
    let time = element.currentTime
    let duration = Number.isFinite(element.duration) ? element.duration : this.view.duration
    if (this.continuous) ({ time, duration } = this.followContinuous(time))
    this.set({ currentTime: time, duration })
    const now = this.now()
    if (now - this.lastLockScreenUpdate > 1000) {
      this.lastLockScreenUpdate = now
      this.reportPosition(time, duration)
    }
    if (now - this.lastPositionSave > 5000) {
      this.lastPositionSave = now
      const current = this.current()
      if (current) this.store.setHistory(Q.updatePosition(this.store.history, current.id, time))
    }
  }

  private ended() {
    const following = Q.next(this.store.queue)
    if (!following) {
      this.set({ playing: false, status: 'ended' })
      if (this.deps.mediaSession) this.deps.mediaSession.playbackState = 'none'
      return
    }
    // Synchronously, inside the event: see the note at the top of this file.
    this.store.setQueue(following)
    this.startedCurrent()
    this.set({ playing: true })
    this.load(0, true)
  }

  private buffering(element: Media) {
    if (!this.view.playing) return
    this.set({ status: 'buffering' })
    if (this.deps.mediaSession) this.deps.mediaSession.playbackState = 'paused'
    if (this.stallTimer !== null) return
    this.stallFrom = element.currentTime
    this.stallTimer = this.timeout(() => {
      this.stallTimer = null
      if (this.view.playing && element === this.element && element.currentTime < this.stallFrom + 1) this.recover()
    }, STALL_TIMEOUT_MS)
  }

  // A broken or stuck stream is loaded again from where it was, with growing waits; HLS that keeps
  // failing falls back to the single-file stream. The server renews expired YouTube addresses itself.
  recover() {
    const video = this.current()
    if (!video || !this.view.playing || this.retryTimer !== null) return
    const mode = this.view.mode
    if (this.view.source === 'hls' && !this.continuous) this.hlsFailures.set(`${mode}:${video.id}`, (this.hlsFailures.get(`${mode}:${video.id}`) ?? 0) + 1)
    if (this.retries >= RETRY_DELAYS_MS.length) {
      this.set({ playing: false, status: 'error', error: 'The video could not be played. Check your connection and try again.' })
      return
    }
    const delay = RETRY_DELAYS_MS[this.retries]
    this.retries += 1
    const position = this.view.currentTime
    this.set({ status: 'buffering' })
    this.retryTimer = this.timeout(() => {
      this.retryTimer = null
      if (this.view.playing && this.current()?.id === video.id && this.view.mode === mode) this.load(position, true)
    }, delay)
  }

  private cameOnline() {
    const element = this.element
    if (!this.view.playing || element.readyState >= 3) return
    this.cancel(this.retryTimer)
    this.retryTimer = null
    this.retries = 0
    this.recover()
  }

  // Locking the phone during a video: carry on as audio. Coming back: back to the video.
  private visibilityChanged(state: DocumentVisibilityState) {
    const { settings } = this.store
    if (state === 'hidden') {
      this.hiddenAt = this.now()
      const wasPlaying = this.view.playing || this.now() - this.playingSince < 1000
      if (settings.backgroundAudio && this.view.mode === 'video' && wasPlaying && this.current()) {
        this.set({ playing: true })
        this.setMode('audio', { auto: true })
      }
    } else if (state === 'visible' && this.view.autoAudio && this.view.mode === 'audio') {
      this.setMode('video')
    }
  }

  private clearStall() { this.cancel(this.stallTimer); this.stallTimer = null }
  private clearTimers() { this.clearStall(); this.cancel(this.retryTimer); this.retryTimer = null }

  // --- history and lock screen ---------------------------------------------------------------------

  private startedCurrent() {
    const video = this.current()
    if (!video) return
    this.retries = 0
    this.store.setHistory(Q.recordHistory(this.store.history, video, this.now()))
    this.set({ currentTime: 0, duration: video.duration ?? 0 })
    this.updateMetadata(video)
  }

  private updateMetadata(video: TomTubeVideo) {
    const mediaSession = this.deps.mediaSession
    const session = this.deps.session()
    if (!mediaSession || typeof MediaMetadata === 'undefined' || !session) return
    mediaSession.metadata = new MediaMetadata({
      title: video.title,
      artist: video.channel,
      album: 'TomTube',
      artwork: [
        { src: thumbnailUrl(session, video.id, 'mqdefault', true), sizes: '320x180', type: 'image/jpeg' },
        { src: thumbnailUrl(session, video.id, 'hqdefault', true), sizes: '480x360', type: 'image/jpeg' },
      ],
    })
  }

  private reportPosition(position: number, duration: number) {
    const mediaSession = this.deps.mediaSession
    if (!mediaSession?.setPositionState || !(duration > 0)) return
    try { mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: this.element.playbackRate || 1 }) } catch { /* browser rejected position update */ }
  }

  private setupMediaSession() {
    const mediaSession = this.deps.mediaSession
    if (!mediaSession) return
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => this.resume()],
      ['pause', () => this.pause()],
      ['nexttrack', () => this.skipNext()],
      ['previoustrack', () => this.skipPrevious()],
      ['seekbackward', (details) => this.seek(this.view.currentTime - (details.seekOffset ?? 10))],
      ['seekforward', (details) => this.seek(this.view.currentTime + (details.seekOffset ?? 10))],
      ['seekto', (details) => { if (details.seekTime !== undefined) this.seek(details.seekTime) }],
    ]
    for (const [action, handler] of actions) {
      try { mediaSession.setActionHandler(action, handler) } catch { /* not supported here */ }
    }
    this.cleanups.push(() => actions.forEach(([action]) => { try { mediaSession.setActionHandler(action, null) } catch { /* not supported */ } }))
  }
}
