import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { localPlaybackDeviceId, useLivePlayback, type LivePlaybackCommand, type LivePlaybackResponse, type LivePlaybackSnapshot } from '../stores/livePlayback'
import { LivePlaybackSync } from './LivePlaybackSync'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]

let server: LivePlaybackResponse
let requests: { url: string; init?: RequestInit }[]

function remoteState(overrides: Partial<LivePlaybackSnapshot> = {}): LivePlaybackSnapshot {
  return { deviceId: 'desktop', deviceName: 'Windows · Chrome', queue: tracks, currentIndex: 1, playing: true, currentTime: 40, duration: 180, volume: 0.8, muted: false, shuffle: false, repeat: 'off', updatedAt: Date.now(), revision: 3, ...overrides }
}

function command(revision: number, action: LivePlaybackCommand['action']): LivePlaybackCommand {
  return { revision, action, targetDeviceId: localPlaybackDeviceId, updatedAt: Date.now() }
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const polls = () => requests.filter((request) => request.url.startsWith('/api/live-playback?'))

describe('LivePlaybackSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    requests = []
    server = { state: null, command: null, commands: [], devices: [], now: Date.now() }
    window.localStorage.clear()
    useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: [tracks[0]], currentIndex: 0, playing: false, currentTime: 0, duration: 200, activitySerial: 0 })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0, connected: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url.startsWith('/api/live-playback?')) return Response.json({ ...server, now: Date.now() })
      if (url === '/api/live-playback' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return Response.json({ state: { ...body, revision: 10, updatedAt: Date.now() } })
      }
      return Response.json({ ok: true })
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not replay a command that was sent before the page loaded', async () => {
    server.commands = [command(4, 'play')]
    render(<LivePlaybackSync/>)
    await flush()
    expect(usePlayer.getState().playing).toBe(false)

    server.commands = [command(4, 'play'), command(5, 'next'), command(6, 'next')]
    usePlayer.setState({ queue: [...tracks, tracks[0]], currentIndex: 0 })
    await flush(10_000)
    expect(usePlayer.getState().currentIndex).toBe(2)
  })

  it('pauses here when another device starts playing', async () => {
    usePlayer.setState({ playing: true })
    server.state = remoteState()
    server.devices = [{ deviceId: 'desktop', deviceName: 'Windows · Chrome', lastSeen: Date.now() }]
    render(<LivePlaybackSync/>)
    await flush()
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('picks up where another device left off once it has stopped, ready to resume here', async () => {
    server.state = remoteState({ playing: false, updatedAt: Date.now() - 120_000 })
    render(<LivePlaybackSync/>)
    await flush()
    const player = usePlayer.getState()
    expect(player.queue[player.currentIndex].id).toBe('b')
    expect(player.currentTime).toBe(40)
    expect(player.playing).toBe(false)
  })

  it('checks rarely in a hidden tab that is not playing, and at once when it comes back', async () => {
    render(<LivePlaybackSync/>)
    await flush()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    const before = polls().length
    await flush(15_000)
    expect(polls().length).toBe(before)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(polls().length).toBe(before + 1)
  })

  it('takes over playback when music is started here, and tells other devices it left when the page closes', async () => {
    render(<LivePlaybackSync/>)
    await flush()
    act(() => usePlayer.getState().playTracks(tracks, 0))
    await flush(200)
    const publish = requests.find((request) => request.url === '/api/live-playback' && request.init?.method === 'POST')
    expect(JSON.parse(String(publish?.init?.body))).toMatchObject({ takeover: true, playing: true, deviceId: localPlaybackDeviceId })

    window.dispatchEvent(new Event('pagehide'))
    const leave = requests.find((request) => request.url === '/api/live-playback/leave')
    expect(leave?.init?.keepalive).toBe(true)
  })
})
