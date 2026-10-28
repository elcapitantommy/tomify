import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TomTubeEngine, RETRY_DELAYS_MS, STALL_TIMEOUT_MS } from './engine'
import { useTomTube, defaultSettings, initialPlayer } from './store'
import { emptyQueue } from './queue'
import type { TomTubeVideo } from './api'
import { mediaTokenStatus, setMediaGrant, startMediaTokens } from './mediaToken'

// A stand-in for <video>/<audio>: records what the engine does and lets tests fire media events.
class FakeMedia extends EventTarget {
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
  load() { this.loads += 1; this.readyState = 0 }
  play() { this.playCalls += 1; this.paused = false; return this.playResult }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')) } }
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

function create() {
  engine = new TomTubeEngine({
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
    expect(videoEl.src).toMatch(/^\/api\/tomtube\/videos\/aaaaaaaaaaa\/master\.m3u8\?mt=tok-2$/)
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

  it('plays a video as HLS through Tomify, and as a single file where HLS is not native', () => {
    engine.playVideo(video('a'))
    expect(videoEl.src).toMatch(/^\/api\/tomtube\/videos\/aaaaaaaaaaa\/master\.m3u8\?mt=tok-1$/)
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
    audioEl.playResult = Promise.resolve()
    mediaSession.action('play')
    expect(player().playing).toBe(true)
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
