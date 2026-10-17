import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { RETRY_DELAYS_MS, STALL_TIMEOUT_MS } from '../lib/playbackRecovery'
import { PlayerRuntime } from './PlayerRuntime'

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

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
})
