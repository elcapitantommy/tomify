import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRIFT_LIMIT_S, TomTubeEngine, LOCK_PAUSE_WINDOW_MS, RETRY_DELAYS_MS, STALL_TIMEOUT_MS, VIDEO_PAUSE_CONFIRM_MS, isAppleMobile, isMobile } from './engine'
import type { ScriptedHls } from './hlsPlayer'
import { useTomTube, defaultSettings, initialPlayer } from './store'
import { emptyQueue } from './queue'
import type { TomTubeVideo } from './api'
import { mediaTokenStatus, setMediaGrant, startMediaTokens } from './mediaToken'

// A stand-in for <video>/<audio>: records what the engine does and lets tests fire media events.
// With `deferEvents`, pause events wait in `queued` until `deliver()`, like a browser's event queue,
// and loading a new source drops them, as the media load algorithm does.
class FakeMedia extends EventTarget {
  deferEvents = false
  queued: Event[] = []
  // play() calls without a source (the tap that lets iOS start the element later).
  emptyPlays = 0
  muted = false
  emptyPlayError = 'AbortError'
  attributes = new Map<string, string>()
  paused = true
  ended = false
  currentTime = 0
  duration = NaN
  readyState = 0
  playbackRate = 1
  playCalls = 0
  loads = 0
  hls = true
  playResult: Promise<void> = Promise.resolve()
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  get src() { return this.getAttribute('src') ?? '' }
  load() { this.loads += 1; this.readyState = 0; this.queued = [] }
  play() {
    if (!this.getAttribute('src')) { this.emptyPlays += 1; return Promise.reject(Object.assign(new Error('empty'), { name: this.emptyPlayError })) }
    this.playCalls += 1
    this.paused = false
    return this.playResult
  }
  pause() { if (!this.paused) { this.paused = true; this.emit(new Event('pause')) } }
  emit(event: Event) { if (this.deferEvents) this.queued.push(event); else this.dispatchEvent(event) }
  deliver() { const events = this.queued; this.queued = []; events.forEach((event) => this.dispatchEvent(event)) }
  canPlayType(type: string) { return this.hls && type === 'application/vnd.apple.mpegurl' ? 'maybe' : '' }
  fire(type: string) { this.dispatchEvent(new Event(type)) }
  metadata(duration: number) { this.duration = duration; this.readyState = 1; this.fire('loadedmetadata') }
}

class FakeMediaSession {
  handlers = new Map<string, ((details: MediaSessionActionDetails) => void) | null>()
  metadata: unknown = null
  playbackState = 'none'
  positions: unknown[] = []
  setActionHandler(action: string, handler: ((details: MediaSessionActionDetails) => void) | null) { this.handlers.set(action, handler) }
  setPositionState(state: unknown) { this.positions.push(state) }
  action(name: string, details: Partial<MediaSessionActionDetails> = {}) { this.handlers.get(name)?.({ action: name, ...details } as MediaSessionActionDetails) }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  set(state: DocumentVisibilityState) { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')) }
}

const session = { serverUrl: 'https://tomify.tomdixon.uk', username: 'tom', token: '0123456789abcdef0123456789abcdef', salt: 'abc123' }
const video = (id: string, duration = 300): TomTubeVideo => ({ id: id.repeat(11).slice(0, 11), title: `Video ${id}`, channel: `Channel ${id}`, duration })

let videoEl: FakeMedia
let audioEl: FakeMedia
let mediaSession: FakeMediaSession
let doc: FakeDocument
let engine: TomTubeEngine
let api: { prefetch: ReturnType<typeof vi.fn>; queueTimeline: ReturnType<typeof vi.fn> }
let clock = 1_000_000

function create(options: { appleMobile?: boolean; mobile?: boolean; scriptedHls?: ScriptedHls | null } = {}) {
  engine?.destroy()
  engine = new TomTubeEngine({
    appleMobile: options.appleMobile ?? false,
    mobile: options.mobile ?? true,
    scriptedHls: options.scriptedHls ?? null,
    video: videoEl as unknown as HTMLMediaElement,
    audio: audioEl as unknown as HTMLMediaElement,
    session: () => session,
    api: api as never,
    mediaSession: mediaSession as unknown as MediaSession,
    document: doc as unknown as Document,
    window: new EventTarget() as unknown as Window,
    now: () => clock,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useTomTube.setState({ queue: emptyQueue, history: [], settings: { ...defaultSettings }, player: { ...initialPlayer }, expanded: false })
  videoEl = new FakeMedia()
  audioEl = new FakeMedia()
  mediaSession = new FakeMediaSession()
  doc = new FakeDocument()
  api = { prefetch: vi.fn(async () => ({ state: 'started' })), queueTimeline: vi.fn(async () => ({ tracks: [], skipped: [] })) }
  vi.stubGlobal('MediaMetadata', class { constructor(readonly init: MediaMetadataInit) {} })
  setMediaGrant({ username: 'tom', token: 'tok-1', expiresAt: Date.now() + 4 * 3600_000 })
  create()
})

afterEach(() => {
  engine.destroy()
  setMediaGrant(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const player = () => useTomTube.getState().player
const queueIds = () => useTomTube.getState().queue.items.map((item) => item.id[0])

describe('TomTube player', () => {
  it('never signs a media URL with the login: without a media token it waits, then plays', () => {
    setMediaGrant(null)
    engine.playVideo(video('a'))
    expect(videoEl.src).toBe('')
    expect(player()).toMatchObject({ playing: true, status: 'loading' })
    setMediaGrant({ username: 'tom', token: 'tok-2', expiresAt: Date.now() + 4 * 3600_000 })
    expect(videoEl.src).toMatch(/^\/api\/tomtube\/videos\/aaaaaaaaaaa\/master\.m3u8\?height=1080&mt=tok-2$/)
    expect(videoEl.playCalls).toBe(1)
    // A token about to expire is not used for a new stream.
    setMediaGrant({ username: 'tom', token: 'tok-old', expiresAt: Date.now() + 60_000 })
    engine.setMode('audio')
    expect(audioEl.src).toBe('')
  })

  it('explains when the server hands out no media tokens', async () => {
    setMediaGrant(null)
    const stop = startMediaTokens({ username: 'tom', token: session.token, salt: session.salt }, vi.fn(async () => new Response('{}', { status: 404 })) as never)
    await vi.waitFor(() => expect(mediaTokenStatus()).toBe('not-configured'))
    engine.playVideo(video('a'))
    expect(videoEl.src).toBe('')
    expect(player()).toMatchObject({ playing: false, status: 'error' })
    expect(player().error).toMatch(/secure media links/)
    stop()
  })

  it('plays 1080p fixed by default, and adaptive HLS when the quality is Automatic', () => {
    engine.playVideo(video('a'))
    expect(videoEl.src).toContain('/master.m3u8?height=1080&mt=')
    useTomTube.getState().setSettings({ videoQuality: 'auto' })
    engine.playVideo(video('b'))
    expect(videoEl.src).toMatch(/\/videos\/bbbbbbbbbbb\/master\.m3u8\?mt=tok-1$/)
  })

  it('plays a video as HLS through Tomify, and as a single file where HLS is not native', () => {
    engine.playVideo(video('a'))
    expect(videoEl.src).toMatch(/^\/api\/tomtube\/videos\/aaaaaaaaaaa\/master\.m3u8\?height=1080&mt=tok-1$/)
    expect(videoEl.playCalls).toBe(1)
    expect(audioEl.src).toBe('')
    expect(player()).toMatchObject({ mode: 'video', playing: true, status: 'loading', source: 'hls' })
    expect(useTomTube.getState().history[0].id).toBe('aaaaaaaaaaa')

    videoEl.hls = false
    engine.playVideo(video('b'))
    expect(videoEl.src).toMatch(/\/videos\/bbbbbbbbbbb\/progressive\.mp4\?/)
    useTomTube.getState().setSettings({ videoQuality: 'compatible' })
    videoEl.hls = true
    engine.playVideo(video('c'))
    expect(videoEl.src).toMatch(/progressive\.mp4/)
  })

  it('switching to audio keeps the position, empties the video and plays the audio element', () => {
    engine.playVideo(video('a'))
    videoEl.metadata(300)
    videoEl.currentTime = 125
    videoEl.fire('timeupdate')
    engine.setMode('audio')
    expect(videoEl.paused).toBe(true)
    expect(videoEl.src).toBe('')
    expect(audioEl.src).toMatch(/\/videos\/aaaaaaaaaaa\/audio\.m3u8\?/)
    expect(audioEl.playCalls).toBe(1)
    audioEl.metadata(300)
    expect(audioEl.currentTime).toBe(125)
    expect(player()).toMatchObject({ mode: 'audio', playing: true })
    expect(api.prefetch).not.toHaveBeenCalled()

    // And back again.
    audioEl.currentTime = 200
    audioEl.fire('timeupdate')
    engine.setMode('video')
    expect(audioEl.src).toBe('')
    expect(videoEl.src).toMatch(/master\.m3u8/)
    videoEl.metadata(300)
    expect(videoEl.currentTime).toBe(200)
  })

  it('a paused video switches to audio without starting', () => {
    engine.playVideo(video('a'))
    engine.pause()
    const plays = audioEl.playCalls
    engine.setMode('audio')
    expect(audioEl.playCalls).toBe(plays)
    expect(player().playing).toBe(false)
  })

  it('shows the video on the lock screen with working controls', () => {
    engine.playVideo(video('a'))
    expect((mediaSession.metadata as { init: MediaMetadataInit }).init).toMatchObject({ title: 'Video a', artist: 'Channel a', album: 'TomTube' })
    expect(((mediaSession.metadata as { init: MediaMetadataInit }).init.artwork ?? [])[0].src).toMatch(/^http:\/\/localhost(:\d+)?\/api\/tomtube\/thumbs\/aaaaaaaaaaa\/mqdefault\.jpg\?/)
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward']) expect(mediaSession.handlers.get(action)).toBeTypeOf('function')
    engine.setMode('audio')
    audioEl.metadata(300)
    audioEl.fire('playing')
    expect(mediaSession.playbackState).toBe('playing')
    clock += 2000
    audioEl.currentTime = 42
    audioEl.fire('timeupdate')
    expect(mediaSession.positions.at(-1)).toEqual({ duration: 300, position: 42, playbackRate: 1 })
    mediaSession.action('pause')
    expect(audioEl.paused).toBe(true)
    expect(player().playing).toBe(false)
    mediaSession.action('play')
    expect(audioEl.paused).toBe(false)
    mediaSession.action('seekto', { seekTime: 100 })
    expect(audioEl.currentTime).toBe(100)
    mediaSession.action('seekbackward', { seekOffset: 30 })
    expect(audioEl.currentTime).toBe(70)
  })

  it('an interruption (a call) pauses, and the lock screen play button resumes', () => {
    engine.playVideo(video('a'))
    engine.setMode('audio')
    audioEl.metadata(300)
    audioEl.fire('playing')
    audioEl.pause() // iOS pauses the element for the call
    expect(player()).toMatchObject({ playing: false, status: 'paused' })
    mediaSession.action('play')
    expect(player().playing).toBe(true)
    expect(audioEl.paused).toBe(false)
  })

  it('at the end of a video the next one starts on the same element inside the ended event', () => {
    engine.playVideo(video('a'))
    useTomTube.getState().setQueue({ ...useTomTube.getState().queue, items: [...useTomTube.getState().queue.items, video('b')] })
    engine.setMode('audio')
    audioEl.metadata(300)
    audioEl.fire('playing')
    const plays = audioEl.playCalls
    audioEl.ended = true
    audioEl.fire('ended')
    // Synchronously: no awaits between `ended` and play().
    expect(audioEl.src).toMatch(/\/videos\/bbbbbbbbbbb\/audio\.m3u8/)
    expect(audioEl.playCalls).toBe(plays + 1)
    expect(videoEl.playCalls).toBe(1)
    expect(useTomTube.getState().queue.index).toBe(1)
    expect((mediaSession.metadata as { init: MediaMetadataInit }).init.title).toBe('Video b')
    audioEl.ended = false
    audioEl.fire('ended')
    expect(player()).toMatchObject({ playing: false, status: 'ended' })
  })

  it('asks the server to fetch the next video\'s audio while in audio mode', () => {
    engine.playVideo(video('a'))
    useTomTube.getState().setQueue({ items: [video('a'), video('b')], index: 0 })
    engine.setMode('audio')
    expect(api.prefetch).toHaveBeenCalledWith(session, 'bbbbbbbbbbb')
  })

  it('on a computer, switching tabs leaves the video and its sound playing', () => {
    create({ mobile: false })
    engine.playVideo(video('a'))
    videoEl.metadata(300)
    videoEl.fire('playing')
    doc.set('hidden')
    doc.set('visible')
    expect(player()).toMatchObject({ mode: 'video', playing: true })
    expect(videoEl.paused).toBe(false)
    expect(audioEl.src).toBe('')
    expect(videoEl.loads).toBe(1)
  })

  it('plays HLS through hls.js where the browser cannot play it natively (Firefox)', () => {
    const attached: string[] = []
    const fatal: Array<() => void> = []
    let detached = 0
    const scripted: ScriptedHls = {
      ready: () => true,
      attach: (element, url, onFatal) => { attached.push(url); fatal.push(onFatal); element.setAttribute('src', 'blob:hls') },
      detach: (element) => { if (!element.getAttribute('src')?.startsWith('blob:')) return false; detached += 1; element.removeAttribute('src'); return true },
    }
    videoEl.hls = false
    audioEl.hls = false
    let readyCalls = 0
    const ready = scripted.ready
    scripted.ready = () => { readyCalls += 1; return ready() }
    create({ mobile: false, scriptedHls: scripted })
    expect(readyCalls).toBe(1) // starts loading hls.js before the first video
    engine.playVideo(video('a'))
    expect(attached).toEqual([expect.stringMatching(/\/videos\/aaaaaaaaaaa\/master\.m3u8\?height=1080&mt=/)])
    expect(player()).toMatchObject({ source: 'hls', playing: true })
    expect(videoEl.playCalls).toBe(1)
    // hls.js giving up goes through the usual retry, then the single file.
    fatal[0]()
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0])
    expect(attached).toHaveLength(2)
    fatal[1]()
    vi.advanceTimersByTime(RETRY_DELAYS_MS[1])
    expect(videoEl.src).toMatch(/progressive\.mp4/)
    expect(detached).toBeGreaterThanOrEqual(2)
    // Audio only plays the M4A file, and the picture's hls.js is stopped.
    engine.playVideo(video('b'))
    engine.setMode('audio')
    expect(audioEl.src).toMatch(/\/videos\/bbbbbbbbbbb\/audio\.m4a/)
    expect(videoEl.src).toBe('')
  })

  it('locking the phone during a video carries on as audio, and coming back returns to video', () => {
    engine.playVideo(video('a'))
    videoEl.metadata(300)
    videoEl.fire('playing')
    videoEl.currentTime = 60
    videoEl.fire('timeupdate')
    doc.set('hidden')
    videoEl.pause() // iOS pauses video in the background
    expect(player()).toMatchObject({ mode: 'audio', playing: true, autoAudio: true })
    expect(audioEl.src).toMatch(/audio\.m3u8/)
    expect(audioEl.playCalls).toBe(1)
    audioEl.metadata(300)
    expect(audioEl.currentTime).toBe(60)
    audioEl.currentTime = 90
    audioEl.fire('timeupdate')
    doc.set('visible')
    expect(player().mode).toBe('video')
    videoEl.metadata(300)
    expect(videoEl.currentTime).toBe(90)

    // Turned off, or chosen by hand, it stays put.
    useTomTube.getState().setSettings({ backgroundAudio: false })
    doc.set('hidden')
    expect(player().mode).toBe('video')
  })

  it('when iOS refuses to start audio without a tap, it waits for the lock screen play button', async () => {
    engine.playVideo(video('a'))
    videoEl.fire('playing')
    audioEl.playResult = Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }))
    doc.set('hidden')
    await vi.runAllTimersAsync()
    expect(player()).toMatchObject({ mode: 'audio', playing: false, status: 'paused' })
    // The lock screen must offer play, not pause.
    expect(mediaSession.playbackState).toBe('paused')
    audioEl.playResult = Promise.resolve()
    const plays = audioEl.playCalls
    mediaSession.action('play')
    expect(player().playing).toBe(true)
    expect(audioEl.playCalls).toBe(plays + 1)
    audioEl.fire('playing')
    expect(mediaSession.playbackState).toBe('playing')
    // Unlocking goes back to the video, paused where the audio was if it never started.
    audioEl.currentTime = 30
    audioEl.fire('timeupdate')
    engine.pause()
    doc.set('visible')
    expect(player()).toMatchObject({ mode: 'video', playing: false })
    expect(videoEl.src).toMatch(/master\.m3u8/)
    expect(videoEl.playCalls).toBe(1)
  })

  describe('handing over from video to audio as the phone locks', () => {
    it('a tap that plays also starts the empty audio element once, so iOS lets it start later', () => {
      engine.playVideo(video('a'))
      expect(audioEl.emptyPlays).toBe(1)
      expect(audioEl.paused).toBe(true)
      expect(audioEl.src).toBe('')
      expect(player()).toMatchObject({ mode: 'video', playing: true })
      engine.pause()
      engine.resume()
      engine.playVideo(video('b'))
      expect(audioEl.emptyPlays).toBe(1)
    })

    it('a pause iOS makes just before the page is hidden still switches to audio, from the exact position', () => {
      engine.playVideo(video('a'))
      videoEl.metadata(300)
      videoEl.fire('playing')
      clock += 10_000
      videoEl.currentTime = 60
      videoEl.fire('timeupdate')
      videoEl.currentTime = 61.7 // played on past the last timeupdate
      videoEl.pause() // iOS, for the lock screen
      expect(player().playing).toBe(false)
      clock += LOCK_PAUSE_WINDOW_MS - 100
      doc.set('hidden')
      expect(player()).toMatchObject({ mode: 'audio', playing: true, autoAudio: true })
      expect(audioEl.playCalls).toBe(1)
      audioEl.metadata(300)
      expect(audioEl.currentTime).toBe(61.7)
    })

    it('pausing within a second of starting and then locking does not start audio', () => {
      engine.playVideo(video('a'))
      videoEl.fire('playing')
      clock += 100
      engine.pause()
      clock += 100
      doc.set('hidden')
      expect(player()).toMatchObject({ mode: 'video', playing: false })
      expect(audioEl.playCalls).toBe(0)
    })

    it('pausing and then locking the phone does not start audio', () => {
      engine.playVideo(video('a'))
      videoEl.fire('playing')
      clock += 10_000
      // Paused with TomTube's own button, then locked straight away.
      engine.pause()
      clock += 50
      doc.set('hidden')
      expect(player()).toMatchObject({ mode: 'video', playing: false })
      expect(audioEl.playCalls).toBe(0)
      doc.set('visible')
      // Paused another way (for example the full-screen player's controls), then locked a moment later.
      engine.resume()
      videoEl.fire('playing')
      clock += 10_000
      videoEl.pause()
      clock += LOCK_PAUSE_WINDOW_MS + 100
      doc.set('hidden')
      expect(player()).toMatchObject({ mode: 'video', playing: false })
      expect(audioEl.playCalls).toBe(0)
      doc.set('visible')
      // Paused with iOS's full-screen controls, then locked inside the window: still the listener's pause.
      engine.resume()
      videoEl.fire('playing')
      clock += 10_000
      Object.assign(videoEl, { webkitDisplayingFullscreen: true })
      videoEl.pause()
      clock += 100
      doc.set('hidden')
      expect(player()).toMatchObject({ mode: 'video', playing: false })
      expect(audioEl.playCalls).toBe(0)
    })

    it('tries the empty audio element again on the next tap if the browser refused it', async () => {
      audioEl.emptyPlayError = 'NotAllowedError'
      engine.playVideo(video('a'))
      await vi.runAllTimersAsync()
      audioEl.emptyPlayError = 'AbortError'
      engine.pause()
      engine.resume()
      await vi.runAllTimersAsync()
      engine.pause()
      engine.resume()
      expect(audioEl.emptyPlays).toBe(2)
    })

    it('the video\'s late pause, after the switch, does not pause the audio or the lock screen', () => {
      videoEl.deferEvents = true
      engine.playVideo(video('a'))
      videoEl.fire('playing')
      clock += 10_000
      doc.set('hidden')
      audioEl.fire('playing')
      expect(mediaSession.playbackState).toBe('playing')
      // iOS's own pause of the video for the lock screen arrives now.
      videoEl.paused = true
      videoEl.queued.push(new Event('pause'))
      videoEl.deliver()
      expect(player()).toMatchObject({ mode: 'audio', playing: true, status: 'playing' })
      expect(mediaSession.playbackState).toBe('playing')
    })

    it('an element no longer in use changes nothing, whatever it reports', () => {
      engine.playVideo(video('a'))
      videoEl.fire('playing')
      engine.setMode('audio')
      audioEl.metadata(300)
      audioEl.fire('playing')
      const before = { ...player() }
      const loads = audioEl.loads
      for (const type of ['pause', 'waiting', 'stalled', 'error', 'ended', 'playing', 'loadedmetadata', 'timeupdate']) videoEl.fire(type)
      vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0])
      expect(player()).toEqual(before)
      expect(audioEl.loads).toBe(loads)
      expect(mediaSession.playbackState).toBe('playing')
    })

    it('a pause this player asked for, reported late, does not stop playback started since', () => {
      engine.playVideo(video('a'))
      engine.setMode('audio')
      audioEl.fire('playing')
      audioEl.deferEvents = true
      engine.pause()
      expect(mediaSession.playbackState).toBe('paused')
      engine.resume()
      audioEl.deliver()
      expect(player()).toMatchObject({ playing: true })
      audioEl.fire('playing')
      expect(mediaSession.playbackState).toBe('playing')
      // The next pause is a real one (headphones out) and must not be mistaken for that old request.
      audioEl.pause()
      audioEl.deliver()
      expect(player()).toMatchObject({ playing: false, status: 'paused' })
      expect(mediaSession.playbackState).toBe('paused')
    })

    it('a reload of the audio does not take its own pause for the listener\'s', () => {
      engine.playVideo(video('a'))
      engine.setMode('audio')
      audioEl.metadata(300)
      audioEl.fire('playing')
      useTomTube.getState().setSettings({ audioFormat: 'file' })
      engine.settingsChanged()
      expect(audioEl.src).toMatch(/audio\.m4a/)
      audioEl.fire('pause') // a stray pause from the old source, after the new one started
      expect(player()).toMatchObject({ mode: 'audio', playing: true })
    })

    it('a pause from a call or Siri still pauses, and shows as paused on the lock screen', () => {
      engine.playVideo(video('a'))
      engine.setMode('audio')
      audioEl.fire('playing')
      audioEl.pause()
      expect(player()).toMatchObject({ playing: false, status: 'paused' })
      expect(mediaSession.playbackState).toBe('paused')
    })
  })

  describe('paired playback on iPhone (the sound never changes hands)', () => {
    // A playing pair: sound from <audio>, picture muted in <video>, both with metadata.
    function playPaired(position = 0) {
      create({ appleMobile: true })
      engine.playVideo(video('a'), position)
      audioEl.metadata(300)
      audioEl.fire('playing')
      videoEl.metadata(300)
      videoEl.fire('playing')
    }

    it('plays the sound from the audio element and the picture muted, from one tap', () => {
      create({ appleMobile: true })
      engine.playVideo(video('a'))
      expect(audioEl.src).toMatch(/\/videos\/aaaaaaaaaaa\/audio\.m4a\?mt=/)
      expect(videoEl.src).toMatch(/\/videos\/aaaaaaaaaaa\/video\.m3u8\?height=1080&mt=/)
      expect(videoEl.muted).toBe(true)
      expect(audioEl.playCalls).toBe(1)
      expect(videoEl.playCalls).toBe(1)
      expect(player()).toMatchObject({ mode: 'video', playing: true, source: 'file' })
      audioEl.fire('playing')
      expect(mediaSession.playbackState).toBe('playing')
    })

    it('locking pauses only the picture; the sound is never reloaded or restarted', () => {
      playPaired()
      const audioLoads = audioEl.loads
      const audioPlays = audioEl.playCalls
      audioEl.currentTime = 42
      doc.set('hidden')
      expect(videoEl.paused).toBe(true)
      expect(audioEl.paused).toBe(false)
      expect(audioEl.loads).toBe(audioLoads)
      expect(audioEl.playCalls).toBe(audioPlays)
      expect(player()).toMatchObject({ mode: 'video', playing: true })
      expect(mediaSession.playbackState).toBe('playing')
      vi.advanceTimersByTime(VIDEO_PAUSE_CONFIRM_MS * 2)
      expect(player().playing).toBe(true)
      // Unlocking: the picture starts again at the sound's position.
      audioEl.currentTime = 95
      doc.set('visible')
      expect(videoEl.paused).toBe(false)
      expect(videoEl.currentTime).toBe(95)
      expect(audioEl.loads).toBe(audioLoads)
    })

    it('iOS pausing the picture just before the page is hidden does not pause the sound', () => {
      playPaired()
      videoEl.pause() // iOS, as the phone locks
      vi.advanceTimersByTime(VIDEO_PAUSE_CONFIRM_MS / 2)
      doc.set('hidden')
      vi.advanceTimersByTime(VIDEO_PAUSE_CONFIRM_MS * 2)
      expect(audioEl.paused).toBe(false)
      expect(player()).toMatchObject({ playing: true })
    })

    it('a pause of the picture while TomTube stays showing (full-screen controls) pauses everything', () => {
      playPaired()
      videoEl.pause()
      expect(audioEl.paused).toBe(false)
      vi.advanceTimersByTime(VIDEO_PAUSE_CONFIRM_MS)
      expect(audioEl.paused).toBe(true)
      expect(player()).toMatchObject({ playing: false, status: 'paused' })
      expect(mediaSession.playbackState).toBe('paused')
      // And playing from those controls plays both again.
      const plays = audioEl.playCalls
      videoEl.paused = false
      videoEl.fire('play')
      expect(audioEl.playCalls).toBe(plays + 1)
      expect(player().playing).toBe(true)
    })

    it('keeps the picture within the drift limit of the sound, without chasing every small gap', () => {
      playPaired()
      clock += 10_000
      audioEl.currentTime = 50
      videoEl.currentTime = 50 - DRIFT_LIMIT_S / 2
      audioEl.fire('timeupdate')
      expect(videoEl.currentTime).toBe(50 - DRIFT_LIMIT_S / 2)
      videoEl.currentTime = 48
      audioEl.fire('timeupdate')
      expect(videoEl.currentTime).toBe(50)
      // Moved again at most every couple of seconds.
      videoEl.currentTime = 49
      clock += 500
      audioEl.fire('timeupdate')
      expect(videoEl.currentTime).toBe(49)
      clock += 2000
      audioEl.fire('timeupdate')
      expect(videoEl.currentTime).toBe(50)
    })

    it('seeking moves both; scrubbing in iOS\'s full-screen player moves the sound', () => {
      playPaired()
      engine.seek(120)
      expect(audioEl.currentTime).toBe(120)
      expect(videoEl.currentTime).toBe(120)
      videoEl.fire('seeking') // this player's own move: the sound stays put
      expect(audioEl.currentTime).toBe(120)
      videoEl.currentTime = 200
      videoEl.fire('seeking')
      expect(audioEl.currentTime).toBe(200)
      expect(player().currentTime).toBe(200)
    })

    it('pause and resume act on both; an interruption of the sound pauses the picture too', () => {
      playPaired()
      engine.pause()
      expect(audioEl.paused).toBe(true)
      expect(videoEl.paused).toBe(true)
      engine.resume()
      expect(audioEl.paused).toBe(false)
      expect(videoEl.paused).toBe(false)
      audioEl.fire('playing')
      audioEl.pause() // a call
      expect(videoEl.paused).toBe(true)
      expect(player()).toMatchObject({ playing: false, status: 'paused' })
      mediaSession.action('play')
      audioEl.fire('playing')
      expect(videoEl.paused).toBe(false)
    })

    it('the picture waits while the sound buffers, and the sound never waits for the picture', () => {
      playPaired()
      audioEl.readyState = 2
      audioEl.fire('waiting')
      expect(videoEl.paused).toBe(true)
      audioEl.readyState = 4
      audioEl.fire('playing')
      expect(videoEl.paused).toBe(false)
      videoEl.fire('waiting')
      vi.advanceTimersByTime(STALL_TIMEOUT_MS + 1000)
      expect(audioEl.paused).toBe(false)
      expect(player()).toMatchObject({ playing: true })
    })

    it('Audio only removes the picture and leaves the sound alone; Video brings it back in step', () => {
      playPaired()
      const audioLoads = audioEl.loads
      const audioPlays = audioEl.playCalls
      engine.setMode('audio')
      expect(videoEl.src).toBe('')
      expect(audioEl.loads).toBe(audioLoads)
      expect(audioEl.playCalls).toBe(audioPlays)
      expect(player()).toMatchObject({ mode: 'audio', playing: true })
      audioEl.currentTime = 77
      engine.setMode('video')
      expect(videoEl.src).toMatch(/video\.m3u8/)
      videoEl.metadata(300)
      expect(videoEl.currentTime).toBe(77)
      expect(audioEl.loads).toBe(audioLoads)
    })

    it('the next queued video starts inside ended; the picture follows only while TomTube is showing', () => {
      playPaired()
      useTomTube.getState().setQueue({ ...useTomTube.getState().queue, items: [...useTomTube.getState().queue.items, video('b')] })
      doc.set('hidden')
      audioEl.ended = true
      audioEl.fire('ended')
      audioEl.ended = false
      expect(audioEl.src).toMatch(/bbbbbbbbbbb\/audio\.m4a/)
      expect(videoEl.src).toBe('')
      doc.set('visible')
      expect(videoEl.src).toMatch(/bbbbbbbbbbb\/video\.m3u8/)
    })

    it('a broken picture is retried, then shown from the single file, then left off; the sound carries on', () => {
      playPaired()
      const audioLoads = audioEl.loads
      videoEl.fire('error')
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0])
      expect(videoEl.src).toMatch(/video\.m3u8/)
      videoEl.fire('error')
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0])
      expect(videoEl.src).toMatch(/progressive\.mp4/)
      expect(videoEl.muted).toBe(true)
      videoEl.fire('error')
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0])
      videoEl.fire('error')
      const src = videoEl.src
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0] * 10)
      expect(videoEl.src).toBe(src)
      expect(audioEl.loads).toBe(audioLoads)
      expect(player()).toMatchObject({ playing: true })
    })

    it('is used only on iPhone and iPad with "Keep listening when the phone locks" on', () => {
      create({ appleMobile: true })
      useTomTube.getState().setSettings({ backgroundAudio: false })
      engine.playVideo(video('a'))
      expect(audioEl.src).toBe('')
      expect(videoEl.src).toMatch(/master\.m3u8/)
      expect(videoEl.muted).toBe(false)
    })
  })

  describe('audio stream format', () => {
    it('plays the single M4A file on iPhone by default, and HLS only when chosen', () => {
      create({ appleMobile: true })
      engine.playVideo(video('a'))
      engine.setMode('audio')
      expect(audioEl.src).toMatch(/audio\.m4a\?/)
      useTomTube.getState().setSettings({ audioFormat: 'hls' })
      engine.settingsChanged()
      expect(audioEl.src).toMatch(/audio\.m3u8\?/)
      useTomTube.getState().setSettings({ audioFormat: 'file' })
      engine.settingsChanged()
      expect(audioEl.src).toMatch(/audio\.m4a\?/)
      // Video is unchanged.
      useTomTube.getState().setSettings({ backgroundAudio: false })
      engine.setMode('video')
      expect(videoEl.src).toMatch(/master\.m3u8\?/)
    })

    it('recognises iPhones and iPads, including iPads that report a Mac', () => {
      expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true)
      expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true)
      expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false)
      expect(isMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36', maxTouchPoints: 5 })).toBe(true)
      expect(isMobile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', maxTouchPoints: 0 })).toBe(false)
      expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 })).toBe(false)
    })
  })

  it('a broken stream is retried from the same place, then falls back from HLS to the single file', () => {
    engine.playVideo(video('a'))
    engine.setMode('audio')
    audioEl.metadata(300)
    audioEl.currentTime = 50
    audioEl.fire('timeupdate')
    audioEl.fire('error')
    expect(player().status).toBe('buffering')
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0])
    expect(audioEl.src).toMatch(/audio\.m3u8/)
    audioEl.metadata(300)
    expect(audioEl.currentTime).toBe(50)
    audioEl.fire('error')
    vi.advanceTimersByTime(RETRY_DELAYS_MS[1])
    expect(audioEl.src).toMatch(/audio\.m4a/)
    audioEl.fire('playing')
    expect(player()).toMatchObject({ status: 'playing', source: 'file' })
  })

  it('gives up with a message after repeated failures', () => {
    engine.playVideo(video('a'))
    for (const delay of RETRY_DELAYS_MS) { videoEl.fire('error'); vi.advanceTimersByTime(delay) }
    videoEl.fire('error')
    expect(player()).toMatchObject({ playing: false, status: 'error' })
    expect(player().error).toMatch(/could not be played/)
  })

  it('a stream stuck buffering for 15 seconds is reloaded', () => {
    engine.playVideo(video('a'))
    engine.setMode('audio')
    audioEl.metadata(300)
    audioEl.currentTime = 30
    audioEl.fire('timeupdate')
    audioEl.fire('waiting')
    expect(player().status).toBe('buffering')
    const loads = audioEl.loads
    vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0])
    expect(audioEl.loads).toBeGreaterThan(loads)
  })

  it('previous restarts the video after five seconds, otherwise goes back', () => {
    engine.playVideo(video('a'))
    engine.playVideo(video('b'))
    videoEl.metadata(300)
    videoEl.currentTime = 30
    videoEl.fire('timeupdate')
    engine.skipPrevious()
    expect(videoEl.currentTime).toBe(0)
    expect(queueIds()).toEqual(['a', 'b'])
    expect(useTomTube.getState().queue.index).toBe(1)
    useTomTube.getState().setPlayer({ currentTime: 0 })
    engine.skipPrevious()
    expect(useTomTube.getState().queue.index).toBe(0)
    expect(videoEl.src).toMatch(/aaaaaaaaaaa/)
  })

  describe('continuous queue (experimental)', () => {
    beforeEach(() => {
      useTomTube.getState().setSettings({ continuousQueue: true })
      api.queueTimeline.mockResolvedValue({ tracks: [{ id: 'aaaaaaaaaaa', offset: 0, duration: 100 }, { id: 'bbbbbbbbbbb', offset: 100, duration: 200 }], skipped: [] })
    })

    it('plays the queue as one stream and follows which video is playing', async () => {
      engine.playVideo(video('a', 100))
      useTomTube.getState().setQueue({ items: [video('a', 100), video('b', 200)], index: 0 })
      engine.setMode('audio')
      expect(audioEl.src).toMatch(/^\/api\/tomtube\/queue\.m3u8\?ids=aaaaaaaaaaa,bbbbbbbbbbb&mt=tok-1/)
      expect(player().continuous).toBe(true)
      await vi.runAllTimersAsync()
      audioEl.metadata(300)
      audioEl.currentTime = 150
      audioEl.fire('timeupdate')
      expect(useTomTube.getState().queue.index).toBe(1)
      expect(player()).toMatchObject({ currentTime: 50, duration: 200 })
      expect((mediaSession.metadata as { init: MediaMetadataInit }).init.title).toBe('Video b')
      engine.seek(20)
      expect(audioEl.currentTime).toBe(120)
      engine.skipPrevious()
      engine.skipPrevious()
      expect(audioEl.currentTime).toBe(0)
      expect(useTomTube.getState().queue.index).toBe(0)
    })

    it('is used only in audio mode and only with something queued', () => {
      engine.playVideo(video('a'))
      engine.setMode('audio')
      expect(audioEl.src).toMatch(/\/videos\/aaaaaaaaaaa\/audio\.m3u8/)
      engine.setMode('video')
      useTomTube.getState().setQueue({ items: [video('a'), video('b')], index: 0 })
      engine.queueChanged()
      expect(videoEl.src).toMatch(/master\.m3u8/)
    })
  })
})

describe('TomTube watch reporting', () => {
  const play = (element: FakeMedia, from: number, to: number) => {
    for (let time = from; time <= to; time += 1) { element.currentTime = time; element.fire('timeupdate') }
  }

  it('reports a watch after 30 seconds, when it ends, and never counts seeking', () => {
    const watched = vi.fn<(session: unknown, report: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    Object.assign(api, { watched })
    create()
    engine.playVideo({ ...video('a', 100), channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' })
    videoEl.metadata(100)
    play(videoEl, 0, 20)
    expect(watched).not.toHaveBeenCalled()
    play(videoEl, 21, 31)
    expect(watched).toHaveBeenCalledTimes(1)
    expect(watched.mock.calls[0][1]).toMatchObject({ id: 'aaaaaaaaaaa', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', seconds: 30, ended: false })
    // A seek to near the end is not watching.
    play(videoEl, 95, 99)
    videoEl.fire('ended')
    expect(watched).toHaveBeenCalledTimes(2)
    expect(watched.mock.calls[1][1]).toMatchObject({ seconds: 35, ended: true })
  })

  it('reports what was watched or skipped when another video starts or TomTube is hidden', () => {
    const watched = vi.fn<(session: unknown, report: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    Object.assign(api, { watched })
    create()
    engine.playVideo(video('a'))
    play(videoEl, 0, 5)
    engine.playVideo(video('b'))
    // Left after five seconds for another video: a skip.
    expect(watched).toHaveBeenCalledTimes(1)
    expect(watched.mock.calls[0][1]).toMatchObject({ id: 'aaaaaaaaaaa', seconds: 5, skipped: true })
    play(videoEl, 0, 15)
    doc.set('hidden')
    expect(watched).toHaveBeenCalledTimes(2)
    expect(watched.mock.calls[1][1]).toMatchObject({ id: 'bbbbbbbbbbb', seconds: 15, ended: false, skipped: false })
  })

  it('on iPhone with paired playback, counts the sound and reports when the phone locks', () => {
    const watched = vi.fn<(session: unknown, report: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    Object.assign(api, { watched })
    create({ appleMobile: true })
    engine.playVideo(video('a'))
    audioEl.metadata(300)
    audioEl.fire('playing')
    play(audioEl, 0, 15)
    // The muted picture's own time is not counted a second time.
    play(videoEl, 0, 15)
    doc.set('hidden')
    expect(watched).toHaveBeenCalledTimes(1)
    expect(watched.mock.calls[0][1]).toMatchObject({ id: 'aaaaaaaaaaa', seconds: 15, ended: false, skipped: false })
  })
})
