import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { ADAPTIVE_START_TIMEOUT_MS, RETRY_DELAYS_MS, STALL_TIMEOUT_MS } from '../lib/playbackRecovery'
import { OUTPUT_CHANGE_GUARD_MS } from '../lib/audioOutputs'
import { PlayerRuntime } from './PlayerRuntime'
import { loadHlsLibrary, resetAdaptiveAvailability } from '../lib/adaptiveStream'
import { DEFAULT_NAVIDROME_SERVER } from '../lib/navidrome'
import { useStreamQuality } from '../stores/streamQuality'
import { useEqualiser } from '../stores/equaliser'
import { FakeAudioContext } from '../test/fakeAudioContext'
import { useNormalisation } from '../stores/normalisation'
import { useDj } from '../stores/dj'
import { useCrossfade } from '../stores/crossfade'
import { useSleepTimer } from '../stores/sleepTimer'
import { FakeIndexedDb } from '../test/fakeIndexedDb'
import { offlineAccount, resetOfflineDbForTests, storeDownload } from '../lib/offline-db'

const hlsPlayers: { source?: string; media?: HTMLMediaElement; destroyed: boolean; emit(event: string, data: unknown): void }[] = []
vi.mock('hls.js/light', () => {
  class FakeHls {
    static Events = { ERROR: 'error', FRAG_LOADED: 'fragLoaded' }
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
    static isSupported = () => true
    handlers: Record<string, (event: string, data: unknown) => void> = {}
    source?: string
    media?: HTMLMediaElement
    destroyed = false
    bandwidthEstimate = 0
    constructor(readonly config: { autoStartLoad: boolean }) { hlsPlayers.push(this) }
    on(event: string, handler: (event: string, data: unknown) => void) { this.handlers[event] = handler }
    loadSource(url: string) { this.source = url }
    attachMedia(media: HTMLMediaElement) { this.media = media }
    startLoad() { this.config.autoStartLoad = true }
    recoverMediaError() {}
    destroy() { this.destroyed = true }
    emit(event: string, data: unknown) { this.handlers[event]?.(event, data) }
  }
  return { default: FakeHls }
})

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
  { id: 'c', title: 'Cowtown', artist: 'They Might Be Giants', album: 'Lincoln', duration: 140 },
]
let requests: string[]

const audio = () => Array.from(document.querySelectorAll('audio'))
const streamed = (element: HTMLAudioElement) => new URL(element.src || 'https://none.example/').searchParams.get('id')

describe('PlayerRuntime', () => {
  beforeEach(() => {
    requests = []
    useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: tracks, currentIndex: 0, playing: false, currentTime: 0, duration: 200, shuffle: false, repeat: 'off' })
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => { requests.push(String(url)); return Response.json({ 'subsonic-response': { status: 'ok' } }) }))
  })

  afterEach(() => { useSleepTimer.getState().cancel(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const fail = (element: HTMLAudioElement, code = 2) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code }) })
    element.dispatchEvent(new Event('error'))
  }
  const heal = (element: HTMLAudioElement) => { Object.defineProperty(element, 'error', { configurable: true, get: () => null }) }
  const setTime = (element: HTMLAudioElement, time: number) => { Object.defineProperty(element, 'currentTime', { configurable: true, writable: true, value: time }) }
  const startPlaying = async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    await act(async () => { usePlayer.getState().setPlaying(true) })
    return audio()
  }

  it('updates the lock screen and car artwork when the album\'s replacement cover loads after playback restores', async () => {
    class Metadata { constructor(value: MediaMetadataInit) { Object.assign(this, value) } }
    vi.stubGlobal('MediaMetadata', Metadata)
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: () => {}, setPositionState: () => {} } })
    useAlbumArtwork.setState({ overrides: {} })
    usePlayer.setState({ queue: [{ ...tracks[0], albumId: 'al-lincoln', coverArt: 'al-lincoln' }] })
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    expect(navigator.mediaSession.metadata!.artwork![0].src).toMatch(/^https:\/\/music\.example\/rest\/getCoverArt/)
    await act(async () => { useAlbumArtwork.setState({ overrides: { 'al-lincoln': { albumId: 'al-lincoln', provider: 'upload', url: '/api/album-artwork/image/new-cover', width: 1200, height: 1200, source: 'manual' } } }) })
    expect(navigator.mediaSession.metadata!.artwork!.map((art) => art.src)).toEqual([window.location.origin + '/api/album-artwork/image/new-cover'])
    useAlbumArtwork.setState({ overrides: {} })
    delete (navigator as { mediaSession?: unknown }).mediaSession
  })

  it('only fetches metadata for a restored, paused queue and does not download the next track', async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    const [current, standby] = audio()
    expect(streamed(current)).toBe('a')
    expect(current.preload).toBe('metadata')
    expect(standby.getAttribute('src')).toBeNull()
    expect(requests.some((url) => url.includes('/rest/scrobble.view'))).toBe(false)
  })

  it('buffers the track and primes the next one once playback starts', async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    await act(async () => { usePlayer.getState().setPlaying(true) })
    const [current, standby] = audio()
    expect(current.preload).toBe('auto')
    expect(streamed(standby)).toBe('b')
    expect(standby.preload).toBe('auto')
    expect(requests.filter((url) => url.includes('/rest/scrobble.view') && url.includes('submission=false'))).toHaveLength(1)
  })

  it('stops at the end of the song when the sleep timer is set to the end of this song', async () => {
    const [first] = await startPlaying()
    useSleepTimer.getState().startEndOfTrack()
    await act(async () => { first.dispatchEvent(new Event('ended')) })
    // The queue moves on to the next song, ready to play, but nothing starts.
    expect(usePlayer.getState().currentIndex).toBe(1)
    expect(usePlayer.getState().playing).toBe(false)
    expect(useSleepTimer.getState().timer).toBeNull()
    // With the timer used up, the next song that ends plays on as normal.
    await act(async () => { usePlayer.getState().setPlaying(true) })
    await act(async () => { audio().find((element) => streamed(element) === 'b')!.dispatchEvent(new Event('ended')) })
    expect(usePlayer.getState().currentIndex).toBe(2)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('does not hand off to a pre-loaded next track whose download failed', async () => {
    const [first, second] = await startPlaying()
    expect(streamed(second)).toBe('b')
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    await act(async () => { fail(second) })
    expect(usePlayer.getState().playing).toBe(true)
    loads.mockClear()
    await act(async () => { first.dispatchEvent(new Event('ended')) })
    expect(usePlayer.getState().currentIndex).toBe(1)
    expect(usePlayer.getState().playing).toBe(true)
    // The broken standby is skipped and the track is loaded fresh in the playing element.
    expect(streamed(first)).toBe('b')
    expect(loads.mock.contexts).toContain(first)
  })

  it('reloads a stream that drops mid-track and carries on from the same spot', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    setTime(current, 42)
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    await act(async () => { fail(current) })
    expect(usePlayer.getState().playing).toBe(true)
    expect(loads).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(RETRY_DELAYS_MS[0]) })
    expect(loads.mock.contexts).toContain(current)
    heal(current)
    Object.defineProperty(current, 'duration', { configurable: true, value: 200 })
    setTime(current, 0)
    await act(async () => { current.dispatchEvent(new Event('loadedmetadata')) })
    expect(current.currentTime).toBe(42)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('stops once every retry has failed', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    for (const delay of RETRY_DELAYS_MS) {
      await act(async () => { fail(current) })
      await act(async () => { vi.advanceTimersByTime(delay) })
    }
    expect(usePlayer.getState().playing).toBe(true)
    await act(async () => { fail(current) })
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('reloads a stream that hangs while buffering', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    await act(async () => { current.dispatchEvent(new Event('waiting')) })
    await act(async () => { vi.advanceTimersByTime(STALL_TIMEOUT_MS) })
    expect(loads).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(RETRY_DELAYS_MS[0]) })
    expect(loads.mock.contexts).toContain(current)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('leaves a short buffering pause alone once playback resumes', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    await act(async () => { current.dispatchEvent(new Event('waiting')) })
    await act(async () => { current.dispatchEvent(new Event('playing')) })
    await act(async () => { vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
    expect(loads).not.toHaveBeenCalled()
  })

  it('leaves a stream alone that keeps playing after a buffering event', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    Object.defineProperty(current, 'paused', { configurable: true, get: () => false })
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    setTime(current, 10)
    await act(async () => { current.dispatchEvent(new Event('waiting')) })
    setTime(current, 24)
    await act(async () => { vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
    expect(loads).not.toHaveBeenCalled()
  })

  it('ignores a stalled download while there is still audio buffered (Safari reports these mid-song)', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    Object.defineProperty(current, 'readyState', { configurable: true, get: () => HTMLMediaElement.HAVE_ENOUGH_DATA })
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    await act(async () => { current.dispatchEvent(new Event('stalled')) })
    await act(async () => { vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
    expect(loads).not.toHaveBeenCalled()
  })

  it('seeks back to the same spot again if the phone drops the seek made while reloading', async () => {
    vi.useFakeTimers()
    const [current] = await startPlaying()
    setTime(current, 42)
    await act(async () => { fail(current) })
    await act(async () => { vi.advanceTimersByTime(RETRY_DELAYS_MS[0]) })
    heal(current)
    Object.defineProperty(current, 'duration', { configurable: true, value: 200 })
    setTime(current, 0)
    await act(async () => { current.dispatchEvent(new Event('loadedmetadata')) })
    setTime(current, 0)
    await act(async () => { current.dispatchEvent(new Event('canplay')) })
    expect(current.currentTime).toBe(42)
  })

  it('keeps playing when play() is interrupted by a newer load', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => Promise.reject(new DOMException('interrupted', 'AbortError')))
    await startPlaying()
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('pauses when the browser blocks playback', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')))
    await startPlaying()
    expect(usePlayer.getState().playing).toBe(false)
  })

  const setPaused = (element: HTMLAudioElement, paused: boolean) => { Object.defineProperty(element, 'paused', { configurable: true, get: () => paused }) }
  const pausedElements = () => vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts

  it('keeps the pre-loaded next track silent if something starts it', async () => {
    const [current, standby] = await startPlaying()
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
    await act(async () => { standby.dispatchEvent(new Event('play')) })
    expect(pausedElements()).toContain(standby)
    expect(pausedElements()).not.toContain(current)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('stays paused when the phone resumes playback by itself after headphones or a car disconnect', async () => {
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: () => {}, setPositionState: () => {} } })
    try {
      const [current] = await startPlaying()
      // The phone pauses the music as the headphones go...
      await act(async () => { current.dispatchEvent(new Event('pause')) })
      expect(usePlayer.getState().playing).toBe(false)
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
      // ...and later starts it again on its own, out of the speaker.
      await act(async () => { current.dispatchEvent(new Event('play')) })
      expect(usePlayer.getState().playing).toBe(false)
      expect(pausedElements()).toContain(current)
    } finally {
      delete (navigator as { mediaSession?: unknown }).mediaSession
    }
  })

  describe('when headphones or a car disconnect', () => {
    let handlers: Map<string, MediaSessionActionHandler | null>
    let devices: EventTarget & { enumerateDevices: () => Promise<MediaDeviceInfo[]> }
    let deviceList: { kind: string; deviceId: string }[]
    const changeDevices = async (list: { kind: string; deviceId: string }[]) => {
      deviceList = list
      await act(async () => { devices.dispatchEvent(new Event('devicechange')) })
      await act(async () => { await Promise.resolve() })
    }
    const sessionAction = async (action: string) => { await act(async () => { handlers.get(action)?.({ action: action as MediaSessionAction }) }) }

    beforeEach(() => {
      handlers = new Map()
      deviceList = [{ kind: 'audiooutput', deviceId: '' }]
      devices = Object.assign(new EventTarget(), { enumerateDevices: async () => deviceList as MediaDeviceInfo[] })
      Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: (action: string, handler: MediaSessionActionHandler | null) => handlers.set(action, handler), setPositionState: () => {} } })
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices })
    })
    afterEach(() => {
      delete (navigator as { mediaSession?: unknown }).mediaSession
      delete (navigator as { mediaDevices?: unknown }).mediaDevices
    })

    it('ignores the play the phone sends as the headphones drop out', async () => {
      const [current] = await startPlaying()
      // Taking the headphones out pauses...
      await sessionAction('pause')
      expect(usePlayer.getState().playing).toBe(false)
      // ...then as they disconnect, the phone sends a play of its own.
      await changeDevices([])
      vi.mocked(HTMLMediaElement.prototype.play).mockClear()
      await sessionAction('play')
      expect(usePlayer.getState().playing).toBe(false)
      expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts).not.toContain(current)
    })

    it('pauses again when that play arrives just before the disconnect is reported', async () => {
      await startPlaying()
      await sessionAction('pause')
      await sessionAction('play')
      expect(usePlayer.getState().playing).toBe(true)
      await changeDevices([])
      expect(usePlayer.getState().playing).toBe(false)
    })

    it('still plays when the listener presses play later on', async () => {
      vi.useFakeTimers()
      await startPlaying()
      await sessionAction('pause')
      await changeDevices([])
      await act(async () => { vi.advanceTimersByTime(OUTPUT_CHANGE_GUARD_MS) })
      await sessionAction('play')
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('keeps playing when a device change has nothing to do with a play request', async () => {
      vi.useFakeTimers()
      await startPlaying()
      await act(async () => { vi.advanceTimersByTime(OUTPUT_CHANGE_GUARD_MS) })
      await changeDevices([{ kind: 'audiooutput', deviceId: '' }, { kind: 'audiooutput', deviceId: '' }])
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('pauses when a known audio device goes away while playing', async () => {
      deviceList = [{ kind: 'audiooutput', deviceId: 'speaker' }, { kind: 'audiooutput', deviceId: 'buds' }]
      vi.useFakeTimers()
      await startPlaying()
      await act(async () => { vi.advanceTimersByTime(OUTPUT_CHANGE_GUARD_MS) })
      await changeDevices([{ kind: 'audiooutput', deviceId: 'speaker' }])
      expect(usePlayer.getState().playing).toBe(false)
    })
  })

  it('stops the DJ\'s link and keeps the music paused when pause is pressed on the headphones or lock screen', async () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>()
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: (action: string, handler: MediaSessionActionHandler | null) => handlers.set(action, handler), setPositionState: () => {} } })
    try {
      await startPlaying()
      await act(async () => { usePlayer.setState({ playing: false }); useDj.setState({ active: true, speaking: true }) })
      await act(async () => { handlers.get('pause')?.({ action: 'pause' }) })
      expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: false }))
      expect(usePlayer.getState().playing).toBe(false)
    } finally {
      useDj.setState({ active: false, speaking: false })
      delete (navigator as { mediaSession?: unknown }).mediaSession
    }
  })

  it('pauses both audio elements when playback is paused', async () => {
    const [current, standby] = await startPlaying()
    setPaused(current, false)
    setPaused(standby, false)
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
    await act(async () => { usePlayer.getState().setPlaying(false) })
    expect(pausedElements()).toContain(current)
    expect(pausedElements()).toContain(standby)
  })

  it('stops the other element when a track is started', async () => {
    const [current, standby] = await startPlaying()
    setPaused(standby, false)
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
    await act(async () => { usePlayer.getState().playTracks(tracks, 2) })
    expect(streamed(current)).toBe('c')
    expect(pausedElements()).toContain(standby)
  })

  it('tells other open copies of Tomify when it starts playing', async () => {
    const heard: unknown[] = []
    const other = new BroadcastChannel('tomify-player')
    other.onmessage = (event) => heard.push(event.data)
    const [current] = await startPlaying()
    await act(async () => { current.dispatchEvent(new Event('play')) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    other.close()
    expect(heard).toContainEqual(expect.objectContaining({ type: 'playing' }))
  })

  it('stops when another open copy of Tomify starts playing', async () => {
    const [current] = await startPlaying()
    setPaused(current, false)
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
    const other = new BroadcastChannel('tomify-player')
    await act(async () => {
      other.postMessage({ type: 'playing', id: 'another-copy' })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    other.close()
    expect(usePlayer.getState().playing).toBe(false)
    expect(pausedElements()).toContain(current)
  })

  it('routes both players through the equaliser only once it is switched on, and starts it with playback', async () => {
    FakeAudioContext.instances = []
    vi.stubGlobal('AudioContext', FakeAudioContext)
    useAuth.setState({ session: { ...session, serverUrl: DEFAULT_NAVIDROME_SERVER } })
    const elements = await startPlaying()
    expect(FakeAudioContext.instances).toHaveLength(0)
    await act(async () => { useEqualiser.getState().setEnabled(true); useEqualiser.getState().choosePreset('treble') })
    const context = FakeAudioContext.instances[0]
    expect(context.sources.map((source) => source.element)).toEqual(elements)
    expect(context.filters.at(-1)!.gain.value).toBe(6)
    expect(context.state).toBe('running')
    await act(async () => { useEqualiser.getState().setEnabled(false) })
    expect(context.filters.at(-1)!.gain.value).toBe(0)
    expect(FakeAudioContext.instances).toHaveLength(1)
    useEqualiser.setState({ enabled: false, preset: 'flat', gains: Array(10).fill(0) })
  })

  it('leaves the players alone when the equaliser is on but streams come from another server', async () => {
    FakeAudioContext.instances = []
    vi.stubGlobal('AudioContext', FakeAudioContext)
    useEqualiser.setState({ enabled: true })
    await startPlaying()
    expect(FakeAudioContext.instances).toHaveLength(0)
    useEqualiser.setState({ enabled: false })
  })

  it('turns an original file down by its ReplayGain and follows a new normalisation setting', async () => {
    usePlayer.setState({ volume: 0.8, muted: false, queue: [{ ...tracks[0], replayGain: { trackGain: -10.0206, trackPeak: 0.5 } }, { ...tracks[1], replayGain: { trackGain: 4, trackPeak: 0.2 } }] })
    const [current, standby] = await startPlaying()
    expect(current.volume).toBeCloseTo(0.4)
    // A track mastered quieter than the reference can't be turned up past the listener's volume.
    expect(standby.volume).toBeCloseTo(0.8)
    await act(async () => { usePlayer.getState().setVolume(0.5) })
    expect(current.volume).toBeCloseTo(0.25)
    await act(async () => { useNormalisation.setState({ setting: 'off' }) })
    expect(current.volume).toBeCloseTo(0.5)
    useNormalisation.setState({ setting: 'auto' })
  })

  describe('adaptive streaming', () => {
    beforeEach(async () => {
      hlsPlayers.length = 0
      resetAdaptiveAvailability()
      vi.stubGlobal('MediaSource', class {})
      useAuth.setState({ session: { ...session, serverUrl: DEFAULT_NAVIDROME_SERVER } })
      useStreamQuality.setState({ quality: 'adaptive' })
      await loadHlsLibrary()
    })
    afterEach(() => { useStreamQuality.setState({ quality: 'adaptive' }) })

    const playerFor = (element: HTMLAudioElement) => hlsPlayers.filter((player) => player.media === element && !player.destroyed).at(-1)

    it('plays the current and pre-loaded next track as adaptive streams through the Worker', async () => {
      const [current, standby] = await startPlaying()
      expect(new URL(playerFor(current)!.source!).pathname).toBe('/api/hls/a/master.m3u8')
      expect(new URL(playerFor(standby)!.source!).pathname).toBe('/api/hls/b/master.m3u8')
      expect(new URL(playerFor(current)!.source!).searchParams.get('u')).toBe('tom')
    })

    it('switches to the original file when the box cannot stream adaptively', async () => {
      vi.useFakeTimers()
      const [current] = await startPlaying()
      await act(async () => { playerFor(current)!.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 503 } }) })
      await act(async () => { vi.advanceTimersByTime(RETRY_DELAYS_MS[0]) })
      expect(playerFor(current)).toBeUndefined()
      expect(streamed(current)).toBe('a')
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('streams straight from the box at home and goes back through the Worker when that fails', async () => {
      const lan = 'https://lan.tomify.example:8789'
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        requests.push(String(url))
        if (String(url) === '/api/media-session') return Response.json({ token: 'sealed', expiresAt: Date.now() + 4 * 3600_000, lanOrigin: lan })
        if (String(url) === `${lan}/lan/ping`) return Response.json({ ok: true })
        return Response.json({ 'subsonic-response': { status: 'ok' } })
      }))
      usePlayer.setState({ currentIndex: 0, playing: false })
      await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
      await vi.waitFor(() => expect(requests).toContain(`${lan}/lan/ping`))
      await act(async () => { await Promise.resolve() })
      vi.useFakeTimers()
      // Track c was not pre-loaded, so it loads now, with the box known to be reachable.
      await act(async () => { usePlayer.setState({ currentIndex: 2 }); usePlayer.getState().setPlaying(true) })
      const current = audio().find((element) => playerFor(element) && new URL(playerFor(element)!.source!).pathname === '/api/hls/c/master.m3u8')!
      const atHome = new URL(playerFor(current)!.source!)
      expect(atHome.origin).toBe(lan)
      expect(Object.fromEntries(atHome.searchParams)).toEqual({ mt: 'sealed' })
      expect(current.crossOrigin).toBe('anonymous')

      await act(async () => { playerFor(current)!.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 0 } }) })
      await act(async () => { vi.advanceTimersByTime(RETRY_DELAYS_MS[0]) })
      // Still adaptive, now through the Worker with the same short-lived token.
      const viaWorker = new URL(playerFor(current)!.source!)
      expect(viaWorker.origin).toBe(window.location.origin)
      expect(viaWorker.searchParams.get('mt')).toBe('sealed')
      expect(viaWorker.searchParams.get('t')).toBeNull()
      expect(current.crossOrigin).toBeNull()
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('switches to the original file when an adaptive stream errors or hangs', async () => {
      vi.useFakeTimers()
      const [current] = await startPlaying()
      expect(playerFor(current)).toBeDefined()
      await act(async () => { current.dispatchEvent(new Event('waiting')) })
      await act(async () => { vi.advanceTimersByTime(STALL_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
      expect(playerFor(current)).toBeUndefined()
      expect(streamed(current)).toBe('a')
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('switches to the original file when an adaptive stream never starts (Safari can stay silent)', async () => {
      vi.useFakeTimers()
      const [current] = await startPlaying()
      expect(playerFor(current)).toBeDefined()
      await act(async () => { vi.advanceTimersByTime(ADAPTIVE_START_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
      expect(playerFor(current)).toBeUndefined()
      expect(streamed(current)).toBe('a')
    })

    it('keeps the adaptive stream once it has started playing', async () => {
      vi.useFakeTimers()
      const [current] = await startPlaying()
      await act(async () => { current.dispatchEvent(new Event('playing')) })
      await act(async () => { vi.advanceTimersByTime(ADAPTIVE_START_TIMEOUT_MS + RETRY_DELAYS_MS[0]) })
      expect(playerFor(current)).toBeDefined()
    })

    it('asks for adaptive streams with the album’s ReplayGain baked in while an album plays in order', async () => {
      const replayGain = { trackGain: -7, trackPeak: 0.9, albumGain: -6, albumPeak: 0.95 }
      usePlayer.setState({ queue: [{ ...tracks[0], albumId: 'lincoln', replayGain }, { ...tracks[1], albumId: 'lincoln', replayGain }, { ...tracks[2], albumId: 'flood' }] })
      const [current, standby] = await startPlaying()
      expect(new URL(playerFor(current)!.source!).pathname).toBe('/api/hls/a/album/master.m3u8')
      expect(new URL(playerFor(standby)!.source!).pathname).toBe('/api/hls/b/album/master.m3u8')
      // The stream is already normalised, so the element plays at the listener's volume.
      expect(current.volume).toBeCloseTo(usePlayer.getState().volume)
    })

    it('asks for the untouched stream when normalisation is off', async () => {
      useNormalisation.setState({ setting: 'off' })
      usePlayer.setState({ queue: [{ ...tracks[0], replayGain: { trackGain: -7 } }, tracks[1]] })
      const [current] = await startPlaying()
      expect(new URL(playerFor(current)!.source!).pathname).toBe('/api/hls/a/master.m3u8')
      useNormalisation.setState({ setting: 'auto' })
    })

    it('streams originals when the device is set to always original', async () => {
      useStreamQuality.setState({ quality: 'original' })
      const [current, standby] = await startPlaying()
      expect(hlsPlayers).toHaveLength(0)
      expect(streamed(current)).toBe('a')
      expect(streamed(standby)).toBe('b')
    })
  })

  it('tells the car and lock screen playback has stopped while the stream is buffering', async () => {
    const positions: MediaPositionState[] = []
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: () => {}, setPositionState: (state: MediaPositionState) => positions.push(state) } })
    try {
      const [current] = await startPlaying()
      expect(navigator.mediaSession.playbackState).toBe('playing')
      Object.defineProperty(current, 'duration', { configurable: true, value: 200 })
      setTime(current, 61)
      await act(async () => { current.dispatchEvent(new Event('waiting')) })
      expect(navigator.mediaSession.playbackState).toBe('paused')
      expect(positions.at(-1)).toMatchObject({ position: 61, duration: 200 })
      expect(usePlayer.getState().playing).toBe(true)
      await act(async () => { current.dispatchEvent(new Event('playing')) })
      expect(navigator.mediaSession.playbackState).toBe('playing')
    } finally {
      delete (navigator as { mediaSession?: unknown }).mediaSession
    }
  })

  it('leaves the lock screen alone when a paused player buffers', async () => {
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none', setActionHandler: () => {}, setPositionState: () => {} } })
    try {
      await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
      const [current] = audio()
      await act(async () => { current.dispatchEvent(new Event('stalled')) })
      expect(navigator.mediaSession.playbackState).toBe('paused')
      await act(async () => { current.dispatchEvent(new Event('playing')) })
      expect(navigator.mediaSession.playbackState).toBe('paused')
    } finally {
      delete (navigator as { mediaSession?: unknown }).mediaSession
    }
  })

  describe('downloaded tracks', () => {
    beforeEach(async () => {
      vi.stubGlobal('indexedDB', new FakeIndexedDb())
      resetOfflineDbForTests()
      let made = 0
      URL.createObjectURL = vi.fn(() => `blob:tomify/${++made}`)
      URL.revokeObjectURL = vi.fn()
      for (const track of tracks.slice(0, 2)) {
        const audioFile = new Blob([`audio-${track.id}`])
        await storeDownload(offlineAccount(session), { id: track.id, track, status: 'available-offline', owners: ['track'], bytes: audioFile.size, addedAt: 1, updatedAt: 1 }, audioFile)
      }
    })
    afterEach(() => resetOfflineDbForTests())

    it('plays the copy on the device instead of streaming, and pre-loads the next downloaded song from it too', async () => {
      const [current, standby] = await startPlaying()
      await vi.waitFor(() => expect(current.src).toBe('blob:tomify/1'))
      await vi.waitFor(() => expect(standby.src).toBe('blob:tomify/2'))
      expect(standby.preload).toBe('auto')
    })

    it('streams a song that is not on the device', async () => {
      usePlayer.setState({ queue: [tracks[2]], currentIndex: 0 })
      const [current] = await startPlaying()
      expect(streamed(current)).toBe('c')
    })
  })
  describe('gapless and crossfade', () => {
    const playingAt = (element: HTMLAudioElement, time: number, duration = 200) => {
      setPaused(element, false)
      Object.defineProperty(element, 'duration', { configurable: true, get: () => duration })
      setTime(element, time)
    }
    const ready = (element: HTMLAudioElement, state: number = HTMLMediaElement.HAVE_ENOUGH_DATA) => { Object.defineProperty(element, 'readyState', { configurable: true, get: () => state }) }
    const played = () => vi.mocked(HTMLMediaElement.prototype.play).mock.contexts
    const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

    beforeEach(() => { useCrossfade.setState({ seconds: 0 }); useDj.setState({ active: false }) })

    it('starts the pre-loaded next song just before this one ends and lets this one play out', async () => {
      vi.useFakeTimers()
      const [first, second] = await startPlaying()
      ready(second)
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
      vi.mocked(HTMLMediaElement.prototype.play).mockClear()
      playingAt(first, 199.5)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      expect(usePlayer.getState().currentIndex).toBe(0)
      await tick(400)
      expect(usePlayer.getState().currentIndex).toBe(1)
      expect(played()).toContain(second)
      expect(pausedElements()).not.toContain(first)
      expect(requests.some((url) => url.includes('/rest/scrobble.view') && url.includes('id=a') && url.includes('submission=true'))).toBe(true)
      await tick(600)
      expect(pausedElements()).toContain(first)
      // The element handed over from is free again and loads the song after next.
      expect(streamed(first)).toBe('c')
    })

    it('fades one song into the next over the crossfade length', async () => {
      vi.useFakeTimers()
      useCrossfade.setState({ seconds: 6 })
      usePlayer.setState({ volume: 0.8, muted: false })
      const [first, second] = await startPlaying()
      ready(second)
      playingAt(first, 195)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(0)
      expect(usePlayer.getState().currentIndex).toBe(1)
      expect(second.volume).toBeCloseTo(0, 1)
      expect(first.volume).toBeCloseTo(0.8, 1)
      await tick(3000)
      expect(second.volume).toBeCloseTo(0.8 * Math.SQRT1_2, 1)
      expect(first.volume).toBeCloseTo(0.8 * Math.SQRT1_2, 1)
      await act(async () => { usePlayer.getState().setVolume(0.5) })
      expect(second.volume).toBeLessThan(0.5)
      await tick(3100)
      expect(pausedElements()).toContain(first)
      expect(second.volume).toBeCloseTo(0.5)
      expect(first.volume).toBeCloseTo(0.5)
    })

    it('keeps songs that run into each other on an album gapless, even with crossfade on', async () => {
      vi.useFakeTimers()
      useCrossfade.setState({ seconds: 6 })
      usePlayer.setState({ queue: tracks.map((track) => ({ ...track, albumId: 'lincoln' })) })
      const [first, second] = await startPlaying()
      ready(second)
      playingAt(first, 195)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(4000)
      expect(usePlayer.getState().currentIndex).toBe(0)
      playingAt(first, 199.6)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(400)
      expect(usePlayer.getState().currentIndex).toBe(1)
      expect(second.volume).toBeCloseTo(usePlayer.getState().volume)
    })

    it('waits for the end as before when the next song is not ready, and on repeat one', async () => {
      vi.useFakeTimers()
      const [first, second] = await startPlaying()
      ready(second, HTMLMediaElement.HAVE_METADATA)
      playingAt(first, 199.5)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(1000)
      expect(usePlayer.getState().currentIndex).toBe(0)
      ready(second)
      await act(async () => { usePlayer.setState({ repeat: 'one' }) })
      playingAt(first, 199.6)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(1000)
      expect(usePlayer.getState().currentIndex).toBe(0)
    })

    it('stops both songs and the fade when paused during a crossfade', async () => {
      vi.useFakeTimers()
      useCrossfade.setState({ seconds: 6 })
      usePlayer.setState({ volume: 0.8 })
      const [first, second] = await startPlaying()
      ready(second)
      playingAt(first, 195)
      await act(async () => { first.dispatchEvent(new Event('timeupdate')) })
      await tick(2000)
      setPaused(second, false)
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
      await act(async () => { usePlayer.getState().setPlaying(false) })
      expect(pausedElements()).toContain(first)
      expect(pausedElements()).toContain(second)
      expect(second.volume).toBeCloseTo(0.8)
    })
  })
})
