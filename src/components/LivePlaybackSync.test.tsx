import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '../stores/player'
import { fetchLivePlayback, localPlaybackDeviceId, publishLivePlayback, useLivePlayback, type LivePlaybackSnapshot } from '../stores/livePlayback'
import type { Track } from '../types'
import { LivePlaybackSync } from './LivePlaybackSync'

vi.mock('../stores/livePlayback', async (importOriginal) => ({
  ...await importOriginal<typeof import('../stores/livePlayback')>(),
  fetchLivePlayback: vi.fn(),
  publishLivePlayback: vi.fn(),
}))

const tracks: Track[] = [{ id: '1', title: 'One', artist: 'A', album: 'X', duration: 200 }, { id: '2', title: 'Two', artist: 'A', album: 'X', duration: 200 }]

function remoteState(deviceId: string, revision: number): LivePlaybackSnapshot {
  return {
    deviceId, deviceName: 'Phone', queue: tracks, currentIndex: 0, playing: false, currentTime: 10, duration: 200,
    volume: 0.8, muted: false, shuffle: false, repeat: 'off', updatedAt: Date.now(), revision,
  }
}

let hidden = false
function setHidden(value: boolean) {
  hidden = value
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const fetchCalls = () => vi.mocked(fetchLivePlayback).mock.calls.length
const publishCalls = () => vi.mocked(publishLivePlayback).mock.calls.length

describe('LivePlaybackSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    usePlayer.getState().clearQueue()
    useLivePlayback.setState({ snapshot: null, connected: false })
    vi.mocked(fetchLivePlayback).mockReset().mockResolvedValue({ state: null, command: null })
    vi.mocked(publishLivePlayback).mockReset().mockImplementation(async (snapshot) => ({ ...snapshot, updatedAt: Date.now(), revision: 1 }))
  })

  afterEach(() => { vi.useRealTimers() })

  it('backs off polling while nothing changes and resets on a remote change', async () => {
    render(<LivePlaybackSync/>)
    await advance(0)
    expect(fetchCalls()).toBe(1)
    await advance(1500)
    expect(fetchCalls()).toBe(2)
    await advance(2999)
    expect(fetchCalls()).toBe(2)
    await advance(1)
    expect(fetchCalls()).toBe(3)
    await advance(6000)
    expect(fetchCalls()).toBe(4)
    await advance(10_000)
    expect(fetchCalls()).toBe(5)
    await advance(10_000)
    expect(fetchCalls()).toBe(6)

    vi.mocked(fetchLivePlayback).mockResolvedValue({ state: remoteState('phone', 7), command: null })
    await advance(10_000)
    expect(fetchCalls()).toBe(7)
    await advance(1500)
    expect(fetchCalls()).toBe(8)
  })

  it('polls fast again after local play, pause or seek', async () => {
    render(<LivePlaybackSync/>)
    await advance(0)
    await advance(1500 + 3000 + 6000)
    expect(fetchCalls()).toBe(4)
    act(() => { usePlayer.getState().playTracks(tracks) })
    await advance(1500)
    expect(fetchCalls()).toBe(5)
  })

  it('pauses both timers while the tab is hidden and resumes when visible', async () => {
    vi.mocked(fetchLivePlayback).mockResolvedValue({ state: remoteState(localPlaybackDeviceId, 1), command: null })
    act(() => { usePlayer.getState().playTracks(tracks); usePlayer.setState({ playing: false }) })
    render(<LivePlaybackSync/>)
    await advance(0)
    setHidden(true)
    const fetched = fetchCalls()
    const published = publishCalls()
    await advance(120_000)
    expect(fetchCalls()).toBe(fetched)
    expect(publishCalls()).toBe(published)

    setHidden(false)
    await advance(0)
    expect(fetchCalls()).toBe(fetched + 1)
    await advance(3000)
    expect(publishCalls()).toBe(published + 1)
  })

  it('keeps a slow poll while hidden if this device is playing', async () => {
    vi.mocked(fetchLivePlayback).mockResolvedValue({ state: remoteState(localPlaybackDeviceId, 1), command: null })
    act(() => { usePlayer.getState().playTracks(tracks) })
    render(<LivePlaybackSync/>)
    await advance(0)
    setHidden(true)
    const fetched = fetchCalls()
    await advance(30_000)
    expect(fetchCalls()).toBe(fetched + 3)
  })

  it('publishes only when the state changed, or as a 30 s keep-alive', async () => {
    vi.mocked(fetchLivePlayback).mockResolvedValue({ state: remoteState(localPlaybackDeviceId, 1), command: null })
    act(() => { usePlayer.getState().playTracks(tracks); usePlayer.setState({ playing: false, currentTime: 10 }) })
    render(<LivePlaybackSync/>)
    await advance(3000)
    expect(publishCalls()).toBe(1)
    await advance(24_000)
    expect(publishCalls()).toBe(1)

    act(() => { usePlayer.getState().setProgress(80, 200) })
    await advance(3000)
    expect(publishCalls()).toBe(2)

    await advance(27_000)
    expect(publishCalls()).toBe(2)
    await advance(3000)
    expect(publishCalls()).toBe(3)
  })
})
