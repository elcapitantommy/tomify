// TomTube's player: one <video> for watching and one <audio> for listening, never both at once.
//
// Background audio is the point of TomTube, so the audio path stands on its own: switching to audio
// notes the video's position, stops and empties the <video> (it is not kept running in the
// background), loads the video's AAC audio into the <audio> element and starts it there. iOS keeps an
// <audio> element playing with the screen locked and shows it on the lock screen through the Media
// Session API, with play/pause, next/previous and seeking, from headphones and Bluetooth too.
//
// iPhone and iPad (paired playback): iOS will not start an audio element while the page is going to
// the background (device testing, even with everything below in place), so on iOS the sound never
// changes hands. With "Keep listening when the phone locks" on, the <audio> element plays the video's
// M4A audio from the moment playback starts, and the <video> element shows the picture muted (a
// video-only stream, so the audio isn't fetched twice), kept within DRIFT_LIMIT_S of the sound. Locking
// the phone only pauses the picture; the sound carries on as it was. Unlocking moves the picture to
// where the sound is. Audio only just removes the picture. The sound is never paused for the picture:
// if the picture buffers it catches up afterwards, because pausing the sound could leave nothing
// playing when the phone locks. If the sound buffers, the picture waits for it.
//
// Elsewhere, locking the phone during a video switches to audio by itself (visibilitychange). Three
// things make that handoff work, or at least fail visibly:
// - iOS starts a media element without a tap only once that element has been started from a tap. The
//   <audio> element is otherwise only ever started from visibilitychange, so every tap that plays
//   something also starts and immediately stops the empty <audio> element (primeAudio). No source is
//   loaded and nothing is heard; it only marks the element as started by the user.
// - Events from the element that is no longer in use, and pauses this player asked for itself (when
//   switching or reloading), never change the player's state or the lock screen's.
// - iOS may pause the video for the lock screen just before the page reports being hidden. That pause
//   is remembered, so the switch to audio still happens and continues from the same position.
// Whether iOS lets a backgrounded page start the <audio> element at all can only be tested on a phone
// (docs/TOMTUBE.md). If it refuses, the lock screen shows TomTube paused and its play button resumes.
//
// Moving to the next queued video while the phone is locked: iOS lets a page that is already playing
// audio start the next source on the same element from its `ended` event, but it may suspend a page
// that has gone silent. So the next source is set and played synchronously inside `ended`, with no
// network request or await first (the URL is built locally; the server has already fetched the next
// track's audio). The experimental alternative plays the whole queue as one continuous HLS stream from
// the server, so nothing has to start at all between tracks. Neither can be proven from a desktop
// browser; see docs/TOMTUBE.md for the device tests.
import type { AuthSession } from '../lib/navidrome'
import { createScriptedHls, type ScriptedHls } from './hlsPlayer'
import { mediaUrl, queueStreamUrl, thumbnailUrl, tomtubeApi, type QueueTimeline, type TomTubeVideo } from './api'
import { mediaTokenStatus, onMediaTokenChange } from './mediaToken'
import * as Q from './queue'
import { useTomTube, type PlaybackMode, type PlayerView } from './store'

export const STALL_TIMEOUT_MS = 15_000
export const RETRY_DELAYS_MS = [1000, 3000, 6000, 10_000, 15_000]
// After this many failed attempts on HLS, the single-file stream is tried instead.
const HLS_FAILURES_BEFORE_FILE = 2
// A pause iOS made this long before the page reports being hidden counts as part of locking the phone.
// Short, so a listener who pauses and then locks the phone stays paused; widen only on device evidence.
export const LOCK_PAUSE_WINDOW_MS = 500
const MAX_CONTINUOUS_TRACKS = 20
// Paired playback: how far the muted picture may drift from the sound before it is moved, and how
// often at most.
export const DRIFT_LIMIT_S = 0.3
const RESYNC_INTERVAL_MS = 2000
// Paired playback: a pause of the picture while TomTube is showing counts as the listener's (iOS's
// full-screen controls) only after this long, because iOS also pauses it as the phone locks, sometimes
// just before the page reports being hidden.
export const VIDEO_PAUSE_CONFIRM_MS = 1000
// Paired playback: attempts at the picture (HLS, then the single file) before showing sound alone.
const VIDEO_ATTEMPTS = HLS_FAILURES_BEFORE_FILE + 2
// Watches are reported to the server's training log (recommendations) once a video has played this
// long, again when it ends or another video starts, and when TomTube goes to the background. A video
// left for another within SKIP_SECONDS of starting is reported as skipped (a weak negative signal).
export const WATCH_REPORT_AFTER_S = 30
export const SKIP_SECONDS = 10

interface WatchSession { video: TomTubeVideo; seconds: number; lastTime: number | null; reported: number; ended: boolean }

type Media = HTMLMediaElement

interface Deps {
  video: Media
  audio: Media
  session: () => AuthSession | null
  api?: Pick<typeof tomtubeApi, 'prefetch' | 'queueTimeline'> & { watched?: typeof tomtubeApi.watched }
  mediaSession?: MediaSession | null
  setTimeout?: (callback: () => void, ms: number) => number
  clearTimeout?: (id: number) => void
  now?: () => number
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  // iPhone and iPad: audio defaults to the single M4A file, which keeps playing with the screen locked
  // (HLS audio was paused by iOS on lock in device testing).
  appleMobile?: boolean
  // A phone or tablet (iOS or Android): going to the background there is the screen locking or another
  // app, so a video carries on as audio. On a computer a hidden tab keeps playing the video as it is.
  mobile?: boolean
  // HLS through hls.js where the browser can't play it natively (Firefox, desktop Chrome, Android).
  scriptedHls?: ScriptedHls | null
}

interface Continuous { ids: string[]; baseIndex: number; timeline: QueueTimeline['tracks'] | null }

export function supportsNativeHls(element: Pick<Media, 'canPlayType'>) {
  try { return element.canPlayType('application/vnd.apple.mpegurl') !== '' } catch { return false }
}

export function isMobile(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator !== 'undefined' ? navigator : undefined) {
  return Boolean(nav) && (isAppleMobile(nav) || /Android|Mobi/i.test(nav!.userAgent))
}

export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { platform?: string } | undefined = typeof navigator !== 'undefined' ? navigator : undefined) {
  if (!nav) return false
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
}

export class TomTubeEngine {
  private readonly video: Media
  private readonly audio: Media
  private readonly deps: Deps
  private pendingSeek: number | null = null
  private retries = 0
  private retryTimer: number | null = null
  private watch: WatchSession | null = null
  private stallTimer: number | null = null
  private stallFrom = 0
  private hlsFailures = new Map<string, number>()
  private continuous: Continuous | null = null
  private lastPositionSave = 0
  private lastLockScreenUpdate = 0
  private playingSince = -Infinity
  private cleanups: Array<() => void> = []
  private stopWaitingForToken: (() => void) | null = null
  // Elements this player paused itself, whose `pause` event is still to come.
  private readonly requestedPauses = new Set<Media>()
  // When iOS (not the listener) last paused a playing video.
  private videoInterruptedAt = -Infinity
  private audioPrimed = false
  private readonly doc: Deps['document'] | undefined
  // Paired playback: where this player last moved the picture to, so iOS's own scrubbing can be told apart.
  private videoSeekTarget: number | null = null
  private lastResync = -Infinity
  private videoPauseTimer: number | null = null
  private videoRetryTimer: number | null = null

  constructor(deps: Deps) {
    this.deps = deps
    this.video = deps.video
    this.audio = deps.audio
    const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined)
    this.doc = doc
    // Before listen(): the paired handlers see the picture's pauses before they are marked as handled.
    this.listenPaired()
    for (const element of [this.video, this.audio]) this.listen(element)
    this.setupMediaSession()
    // Start loading hls.js now where it is needed, so the first video already gets HLS.
    if (!supportsNativeHls(this.video)) this.scriptedHls?.ready()
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
    this.reportWatch()
    this.cleanups.forEach((cleanup) => cleanup())
    this.clearTimers()
    for (const element of [this.video, this.audio]) this.scriptedHlsInstance?.detach(element)
  }

  // --- state -------------------------------------------------------------------------------------

  private get store() { return useTomTube.getState() }
  private get view() { return this.store.player }
  private set(view: Partial<PlayerView>) { this.store.setPlayer(view) }
  // The element that carries the sound and the player's state: the <audio> element in audio mode and
  // in paired playback, otherwise the <video> element.
  private get element(): Media { return this.view.mode === 'audio' || this.paired ? this.audio : this.video }
  private get appleMobile() { return this.deps.appleMobile ?? isAppleMobile() }
  private get mobile() { return this.deps.mobile ?? (this.appleMobile || isMobile()) }
  private scriptedHlsInstance: ScriptedHls | null | undefined
  private get scriptedHls() {
    if (this.scriptedHlsInstance === undefined) this.scriptedHlsInstance = this.deps.scriptedHls !== undefined ? this.deps.scriptedHls : createScriptedHls()
    return this.scriptedHlsInstance
  }
  // Video HLS in this browser: natively, or through hls.js once it has loaded (the first video while
  // it loads plays the single file).
  private canPlayVideoHls() { return supportsNativeHls(this.video) || Boolean(this.scriptedHls?.ready()) }

  // Sets an element's source. HLS goes through hls.js where the browser can't play it natively.
  private setSource(element: Media, url: string, hls: boolean, onFatal: () => void) {
    this.scriptedHls?.detach(element)
    if (hls && !supportsNativeHls(element) && this.scriptedHls?.ready()) {
      this.scriptedHls.attach(element, url, onFatal)
      return
    }
    element.setAttribute('src', url)
    element.load()
  }
  private get paired() { return this.appleMobile && this.store.settings.backgroundAudio }
  private get videoAttached() { return this.paired && this.view.mode === 'video' && Boolean(this.video.getAttribute('src')) }
  private visible() { return this.doc?.visibilityState !== 'hidden' }
  private now() { return this.deps.now?.() ?? Date.now() }
  private timeout(callback: () => void, ms: number) { return (this.deps.setTimeout ?? ((cb, delay) => window.setTimeout(cb, delay)))(callback, ms) }
  private cancel(id: number | null) { if (id !== null) (this.deps.clearTimeout ?? ((value) => window.clearTimeout(value)))(id) }

  current(): TomTubeVideo | null { return Q.current(this.store.queue) }

  // --- sources -----------------------------------------------------------------------------------

  private get fixedHeight() { return this.store.settings.videoQuality === '1080' ? 1080 : undefined }

  private useHls(id: string, mode: PlaybackMode) {
    const { settings } = this.store
    if (mode === 'video' && settings.videoQuality === 'compatible') return false
    if (mode === 'audio' && (settings.audioFormat === 'file' || (settings.audioFormat === 'auto' && this.appleMobile))) return false
    if ((this.hlsFailures.get(`${mode}:${id}`) ?? 0) >= HLS_FAILURES_BEFORE_FILE) return false
    return mode === 'audio' ? supportsNativeHls(this.audio) : this.canPlayVideoHls()
  }

  private sourceFor(video: TomTubeVideo, mode: PlaybackMode) {
    const session = this.deps.session()
    if (!session) return null
    const hls = this.useHls(video.id, mode)
    const file = mode === 'audio' ? (hls ? 'audio.m3u8' : 'audio.m4a') : (hls ? 'master.m3u8' : 'progressive.mp4')
    return { url: mediaUrl(session, video.id, file, this.fixedHeight), kind: hls ? 'hls' as const : 'file' as const }
  }

  // Pauses an element on this player's behalf, so its `pause` event isn't taken for the listener's or iOS's.
  private pauseElement(element: Media) {
    if (!element.paused) this.requestedPauses.add(element)
    element.pause()
  }

  private release(element: Media) {
    this.pauseElement(element)
    this.scriptedHls?.detach(element)
    if (element.getAttribute('src')) {
      element.removeAttribute('src')
      element.load()
    }
    // Emptying an element drops its queued events, so its pause may never be reported.
    this.requestedPauses.delete(element)
  }

  // Loads the current video into the element for `mode`, starting at `position`. Everything here is
  // synchronous, so it can run inside a media event or a tap and still be allowed to play.
  private load(position = 0, autoplay = this.view.playing) {
    const video = this.current()
    if (!video) return
    const mode = this.view.mode
    const element = this.element
    const sourceMode: PlaybackMode = element === this.audio ? 'audio' : 'video'
    // In paired playback the picture is attached again below, once the sound is set up.
    this.release(element === this.audio ? this.video : this.audio)
    this.clearTimers()
    const continuous = mode === 'audio' && this.continuousIds()
    const session = this.deps.session()
    if (!session) return
    let url: string | null
    let source: 'hls' | 'file'
    if (continuous) {
      url = queueStreamUrl(session, continuous)
      source = 'hls'
    } else {
      const chosen = this.sourceFor(video, sourceMode)
      if (!chosen) return
      url = chosen.url
      source = chosen.kind
    }
    // No media token yet (just opened, or offline): wait for one rather than sign the URL any other way.
    if (!url) { this.release(element); this.waitForToken(video, mode, position, autoplay); return }
    if (continuous) {
      this.continuous = { ids: continuous, baseIndex: this.store.queue.index, timeline: null }
      void this.loadTimeline(this.continuous)
    } else this.continuous = null
    this.pendingSeek = position > 0.5 ? position : null
    if (element === this.video) this.video.muted = false
    this.setSource(element, url, source === 'hls', () => { if (this.element === element) this.recover() })
    this.set({ status: 'loading', error: null, currentTime: position, duration: video.duration ?? 0, source, continuous: Boolean(continuous), playing: autoplay })
    this.updateMetadata(video)
    if (autoplay) this.start(element)
    if (sourceMode === 'audio') this.prefetchAhead()
    if (this.paired && mode === 'video') this.attachVideo(video, autoplay)
  }

  // --- paired playback (iPhone): the muted picture beside the sound ---------------------------------

  // Not while hidden: iOS would only suspend it; it is attached when TomTube is showing again.
  private attachVideo(item: TomTubeVideo, play: boolean) {
    const session = this.deps.session()
    if (!session || !this.visible()) return
    const hls = this.useHls(item.id, 'video')
    const url = mediaUrl(session, item.id, hls ? 'video.m3u8' : 'progressive.mp4', this.fixedHeight)
    if (!url) return
    this.cancelVideoTimers()
    this.video.muted = true
    this.videoSeekTarget = null
    this.setSource(this.video, url, hls, () => { if (this.videoAttached) this.videoFailed() })
    if (play) this.startVideo()
  }

  private startVideo() {
    this.requestedPauses.delete(this.video)
    try { this.video.play()?.catch(() => undefined) } catch { /* the picture is optional; the sound carries on */ }
  }

  // Moves the picture to the sound when they are more than DRIFT_LIMIT_S apart.
  private syncVideo(force = false) {
    if (!this.videoAttached || this.video.readyState < 1) return
    const target = this.audio.currentTime
    if (!Number.isFinite(target) || Math.abs(this.video.currentTime - target) < DRIFT_LIMIT_S) return
    const now = this.now()
    if (!force && now - this.lastResync < RESYNC_INTERVAL_MS) return
    this.lastResync = now
    this.videoSeekTarget = target
    try { this.video.currentTime = target } catch { /* tried again on the next timeupdate */ }
  }

  // A broken picture is loaded again (HLS twice, then the single file); after that the sound plays alone.
  private videoFailed() {
    const item = this.current()
    if (!item) return
    const key = `video:${item.id}`
    const failures = (this.hlsFailures.get(key) ?? 0) + 1
    this.hlsFailures.set(key, failures)
    if (failures >= VIDEO_ATTEMPTS) return
    this.cancel(this.videoRetryTimer)
    this.videoRetryTimer = this.timeout(() => {
      this.videoRetryTimer = null
      if (this.paired && this.view.mode === 'video' && this.current()?.id === item.id && this.audio.getAttribute('src')) this.attachVideo(item, this.view.playing)
    }, RETRY_DELAYS_MS[0])
  }

  private cancelVideoTimers() {
    this.cancel(this.videoPauseTimer)
    this.videoPauseTimer = null
    this.cancel(this.videoRetryTimer)
    this.videoRetryTimer = null
  }

  // The picture's own events, while it is paired with the sound. The sound's events go through listen().
  private listenPaired() {
    const video = this.video
    const on = (type: string, handler: () => void) => {
      const wrapped = () => { if (this.videoAttached) handler() }
      video.addEventListener(type, wrapped)
      this.cleanups.push(() => video.removeEventListener(type, wrapped))
    }
    on('loadedmetadata', () => this.syncVideo(true))
    on('playing', () => {
      this.cancel(this.videoPauseTimer)
      this.videoPauseTimer = null
      this.syncVideo(true)
    })
    on('seeking', () => {
      const target = this.videoSeekTarget
      this.videoSeekTarget = null
      if (target !== null && Math.abs(video.currentTime - target) < 0.5) return
      // Scrubbed in iOS's full-screen player: the sound follows.
      try { this.audio.currentTime = video.currentTime } catch { /* not seekable yet */ }
      this.set({ currentTime: video.currentTime })
    })
    on('pause', () => {
      if (!video.paused || video.ended) return
      if (this.requestedPauses.delete(video)) return
      if (!this.view.playing || !this.visible()) return
      // iOS's full-screen controls, or iOS pausing the picture as the phone locks: only the first
      // leaves TomTube showing a second later.
      this.cancel(this.videoPauseTimer)
      this.videoPauseTimer = this.timeout(() => {
        this.videoPauseTimer = null
        if (this.videoAttached && this.visible() && video.paused && this.view.playing) this.pause()
      }, VIDEO_PAUSE_CONFIRM_MS)
    })
    // Played from iOS's full-screen controls while TomTube was paused.
    on('play', () => { if (!this.view.playing && this.visible()) this.resume() })
    on('error', () => this.videoFailed())
  }

  private waitForToken(video: TomTubeVideo, mode: PlaybackMode, position: number, autoplay: boolean) {
    const notConfigured = () => this.set({ playing: false, status: 'error', error: 'TomTube needs secure media links, which are not set up on the Tomify server yet.' })
    if (mediaTokenStatus() === 'not-configured') { notConfigured(); return }
    this.set({ status: 'loading', error: null, currentTime: position, duration: video.duration ?? 0, playing: autoplay })
    this.updateMetadata(video)
    this.stopWaitingForToken = onMediaTokenChange(() => {
      const status = mediaTokenStatus()
      if (status !== 'ready' && status !== 'not-configured') return
      this.stopWaitingForToken?.()
      this.stopWaitingForToken = null
      if (status === 'not-configured') notConfigured()
      else if (this.current()?.id === video.id && this.view.mode === mode) this.load(position, autoplay && this.view.playing)
    })
  }

  private start(element: Media) {
    // Starting again settles any pause this player asked for earlier; its late event is ignored below.
    this.requestedPauses.delete(element)
    const attempt = element.play()
    if (!attempt) return
    attempt.catch((error: unknown) => {
      const name = (error as { name?: string } | null)?.name
      if (name === 'AbortError' || element !== this.element) return
      // iOS refused to start without a tap (for example switching to audio after the screen locked):
      // stay ready, so the lock screen's play button starts it.
      if (name === 'NotAllowedError') { this.set({ playing: false, status: 'paused' }); this.setSessionState('paused'); return }
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
    this.primeAudio()
    this.store.setQueue(Q.playNow(this.store.queue, video))
    this.startedCurrent()
    this.load(position, true)
  }

  playAt(index: number) {
    const queue = this.store.queue
    if (index === queue.index || !queue.items[index]) return
    this.primeAudio()
    if (this.continuous && this.jumpWithinContinuous(index)) return
    this.store.setQueue(Q.jumpTo(queue, index))
    this.startedCurrent()
    this.load(0, true)
  }

  resume() {
    const element = this.element
    if (!this.current()) return
    this.primeAudio()
    if (!element.getAttribute('src') || this.view.status === 'error') { this.set({ playing: true }); this.load(this.view.currentTime, true); return }
    this.set({ playing: true })
    if (this.view.status === 'ended') this.seek(0)
    this.start(element)
    if (this.videoAttached && this.visible()) this.startVideo()
  }

  pause() {
    // The listener stopped it: locking now must not count it as just playing or just interrupted.
    this.playingSince = -Infinity
    this.videoInterruptedAt = -Infinity
    this.set({ playing: false, status: this.current() ? 'paused' : 'idle' })
    this.clearTimers()
    this.pauseElement(this.element)
    if (this.videoAttached) this.pauseElement(this.video)
    this.setSessionState('paused')
  }

  toggle() { if (this.view.playing) this.pause(); else this.resume() }

  // Position within the current video.
  seek(seconds: number) {
    const element = this.element
    const target = Math.max(0, seconds)
    const offset = this.continuousOffset()
    if (element.readyState >= 1) element.currentTime = target + offset
    else this.pendingSeek = target + offset
    if (this.videoAttached && this.video.readyState >= 1) {
      this.videoSeekTarget = target
      this.lastResync = this.now()
      try { this.video.currentTime = target } catch { /* moved on the next timeupdate */ }
    }
    this.set({ currentTime: target })
  }

  skipNext() {
    const following = Q.next(this.store.queue)
    if (!following) return
    this.primeAudio()
    if (this.continuous && this.jumpWithinContinuous(following.index)) return
    this.store.setQueue(following)
    this.startedCurrent()
    this.load(0, true)
  }

  skipPrevious() {
    this.primeAudio()
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
    const item = this.current()
    // Paired playback: the sound carries on untouched; only the picture comes or goes.
    if (this.paired && item && this.audio.getAttribute('src') && !this.continuous && !(mode === 'audio' && this.continuousIds())) {
      this.set({ mode, autoAudio: false })
      if (mode === 'audio') { this.cancelVideoTimers(); this.release(this.video) } else this.attachVideo(item, this.view.playing)
      return
    }
    // The element's own position is the freshest; timeupdate can be up to a quarter of a second behind.
    const from = this.element
    const position = !this.continuous && from.getAttribute('src') && from.readyState >= 1 && Number.isFinite(from.currentTime) ? from.currentTime : this.view.currentTime
    const playing = this.view.playing
    this.set({ mode, autoAudio: auto && mode === 'audio' })
    if (!this.current()) { this.release(mode === 'audio' ? this.video : this.audio); return }
    this.load(position, playing)
  }

  // Called from taps (and lock-screen buttons): see the note at the top of this file. play() on the
  // empty element counts as the user starting it; pause() straight after rejects that play() with an
  // AbortError, so nothing loads or plays. If the browser refused it (NotAllowedError) or threw, the
  // next tap tries again. Whether WebKit then lets the element start in the background is a device test.
  private primeAudio() {
    if (this.audioPrimed || this.view.mode !== 'video' || this.audio.getAttribute('src')) return
    this.audioPrimed = true
    try {
      this.audio.play()?.catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === 'NotAllowedError') this.audioPrimed = false
      })
      this.audio.pause()
    } catch { this.audioPrimed = false }
  }

  private setSessionState(state: MediaSessionPlaybackState) {
    if (this.deps.mediaSession) this.deps.mediaSession.playbackState = state
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
      const wrapped = () => {
        if (active()) handler()
        // An element no longer in use: its late events change nothing, and a pause it reports is done.
        else if (type === 'pause' && element.paused) this.requestedPauses.delete(element)
      }
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
      this.setSessionState('playing')
      // Paired: the picture waits for the sound (after buffering or an interruption).
      if (element === this.audio && this.videoAttached && this.visible() && this.video.paused) { this.startVideo(); this.syncVideo(true) }
    })
    on('pause', () => {
      // Late: the element has been emptied or started again since (a switch, a reload, a new source).
      if (!element.paused || element.ended || !element.getAttribute('src')) { this.requestedPauses.delete(element); return }
      // This player paused it (pause(), a switch or a reload) and has already set the state it wants.
      if (this.requestedPauses.delete(element)) return
      // A pause nobody here asked for: a phone call, Siri, headphones unplugged, or iOS pausing a video
      // for the lock screen. The lock screen's play button resumes it.
      // Inline, TomTube's video has no native controls, so a pause there is iOS's (or a call's). Full
      // screen has iOS's own controls, so a pause there may be the listener's: never taken for locking.
      if (this.view.playing && this.view.mode === 'video' && !this.inFullScreen(element)) this.videoInterruptedAt = this.now()
      if (this.view.playing) this.set({ playing: false, status: 'paused' })
      this.setSessionState('paused')
      if (element === this.audio && this.videoAttached) this.pauseElement(this.video)
    })
    on('waiting', () => this.buffering(element))
    on('stalled', () => { if (element.readyState < 3) this.buffering(element) })
    on('ended', () => this.ended())
    on('error', () => this.recover())
  }

  private inFullScreen(element: Media) {
    const fullScreen = element as Media & { webkitDisplayingFullscreen?: boolean }
    return Boolean(fullScreen.webkitDisplayingFullscreen) || (typeof document !== 'undefined' && document.fullscreenElement === element)
  }

  private timeUpdate(element: Media) {
    let time = element.currentTime
    let duration = Number.isFinite(element.duration) ? element.duration : this.view.duration
    if (this.continuous) ({ time, duration } = this.followContinuous(time))
    this.set({ currentTime: time, duration })
    if (element === this.audio) this.syncVideo()
    this.countWatched(time)
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
    if (this.watch) { this.watch.ended = true; this.reportWatch() }
    const following = Q.next(this.store.queue)
    if (!following) {
      this.set({ playing: false, status: 'ended' })
      this.setSessionState('none')
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
    this.setSessionState('paused')
    if (element === this.audio && this.videoAttached) this.pauseElement(this.video)
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
    const kind: PlaybackMode = this.element === this.audio ? 'audio' : 'video'
    if (this.view.source === 'hls' && !this.continuous) this.hlsFailures.set(`${kind}:${video.id}`, (this.hlsFailures.get(`${kind}:${video.id}`) ?? 0) + 1)
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
    if (state === 'hidden') this.reportWatch()
    if (this.paired) {
      const item = this.current()
      if (this.view.mode !== 'video' || !item) return
      if (state === 'hidden') {
        // Locked: only the picture stops; the sound is already playing and carries on.
        this.cancelVideoTimers()
        if (this.video.getAttribute('src')) this.pauseElement(this.video)
      } else if (!this.video.getAttribute('src')) {
        if (this.audio.getAttribute('src')) this.attachVideo(item, this.view.playing)
      } else {
        if (this.view.playing) this.startVideo()
        this.syncVideo(true)
      }
      return
    }
    if (state === 'hidden') {
      const now = this.now()
      // Playing, just started, or paused by iOS a moment ago as the phone locked.
      const wasPlaying = this.view.playing || now - this.playingSince < 1000 || now - this.videoInterruptedAt < LOCK_PAUSE_WINDOW_MS
      if (settings.backgroundAudio && this.mobile && this.view.mode === 'video' && wasPlaying && this.current()) {
        this.set({ playing: true })
        this.setMode('audio', { auto: true })
      }
    } else if (state === 'visible' && this.view.autoAudio && this.view.mode === 'audio') {
      this.setMode('video')
    }
  }

  private clearStall() { this.cancel(this.stallTimer); this.stallTimer = null }
  private clearTimers() {
    this.clearStall()
    this.cancelVideoTimers()
    this.cancel(this.retryTimer)
    this.retryTimer = null
    this.stopWaitingForToken?.()
    this.stopWaitingForToken = null
  }

  // --- history and lock screen ---------------------------------------------------------------------

  // Seconds actually played: small forward steps of the playhead while playing (seeks don't count).
  private countWatched(time: number) {
    const watch = this.watch
    if (!watch || !this.view.playing || watch.video.id !== this.current()?.id) return
    if (watch.lastTime !== null) {
      const step = time - watch.lastTime
      if (step > 0 && step < 5) watch.seconds += step
    }
    watch.lastTime = time
    if (watch.reported === 0 && watch.seconds >= WATCH_REPORT_AFTER_S) this.reportWatch()
  }

  // `leaving`: another video is starting in its place.
  private reportWatch(leaving = false) {
    const watch = this.watch
    const session = this.deps.session()
    if (!watch || !session || !this.deps.api?.watched || watch.reported === -1) return
    let skipped = false
    if (!watch.ended && watch.seconds < SKIP_SECONDS) {
      // Left within a few seconds of actually playing: a skip. Otherwise too early to say anything.
      if (!leaving || watch.reported !== 0 || watch.lastTime === null) return
      skipped = true
    } else if (!watch.ended && watch.seconds - watch.reported < 5) return
    const { video } = watch
    watch.reported = watch.ended || skipped ? -1 : watch.seconds
    void this.deps.api.watched(session, { id: video.id, title: video.title, channel: video.channel, channelId: video.channelId ?? null, duration: video.duration ?? (this.view.duration || null), seconds: Math.round(watch.seconds), ended: watch.ended, skipped }).catch(() => undefined)
  }

  private startedCurrent() {
    const video = this.current()
    this.reportWatch(true)
    this.watch = video ? { video, seconds: 0, lastTime: null, reported: 0, ended: false } : null
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
      artwork: ([['mqdefault', '320x180'], ['hqdefault', '480x360']] as const).flatMap(([variant, sizes]) => {
        const src = thumbnailUrl(session, video.id, variant, true)
        return src ? [{ src, sizes, type: 'image/jpeg' }] : []
      }),
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
