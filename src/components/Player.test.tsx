import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useLivePlayback, type LivePlaybackSnapshot } from '../stores/livePlayback'
import { PlayerBar } from './Player'
import { useRadio } from '../stores/radio'

vi.mock('./Artwork', () => ({ Artwork: () => null }))
vi.mock('./Lyrics', () => ({ LyricsPanel: ({ track, time, onSeek }: { track: { title: string }; time: number; onSeek: (time: number) => void }) => <button onClick={() => onSeek(12)}>Lyrics of {track.title} at {Math.floor(time)}</button> }))

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]
let requests: { url: string; body?: Record<string, unknown> }[]

function remote(overrides: Partial<LivePlaybackSnapshot> = {}): LivePlaybackSnapshot {
  return { deviceId: 'desktop', deviceName: 'Windows · Chrome', queue: tracks, currentIndex: 1, playing: true, currentTime: 40, duration: 180, volume: 0.8, muted: false, shuffle: false, repeat: 'off', updatedAt: Date.now(), revision: 3, ...overrides }
}

describe('PlayerBar across devices', () => {
  beforeEach(() => {
    requests = []
    useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: [tracks[0]], currentIndex: 0, playing: false, currentTime: 0, duration: 200, queueOpen: false, nowPlayingOpen: false })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0 })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === '/api/live-playback' && init?.method === 'POST') return Response.json({ state: { ...JSON.parse(String(init.body)), revision: 9, updatedAt: Date.now() } })
      return Response.json({ ok: true })
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows and controls the other device, updating the button straight away', async () => {
    useLivePlayback.setState({ snapshot: remote(), devices: [{ deviceId: 'desktop', deviceName: 'Windows · Chrome', lastSeen: Date.now() }] })
    usePlayer.setState({ nowPlayingOpen: true })
    render(<PlayerBar/>)
    expect(screen.getByText('Playing on Windows · Chrome')).toBeInTheDocument()

    const nowPlaying = document.querySelector('.now-playing') as HTMLElement
    await act(async () => { fireEvent.click(within(nowPlaying).getByRole('button', { name: 'Pause' })) })
    expect(within(nowPlaying).getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(requests.find((request) => request.url === '/api/live-playback/command')?.body).toMatchObject({ targetDeviceId: 'desktop', action: 'pause' })
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('moves playback here from the other device at the same track', () => {
    useLivePlayback.setState({ snapshot: remote(), devices: [{ deviceId: 'desktop', deviceName: 'Windows · Chrome', lastSeen: Date.now() }] })
    usePlayer.setState({ nowPlayingOpen: true })
    render(<PlayerBar/>)
    fireEvent.click(screen.getByRole('button', { name: 'Play on this device' }))
    const player = usePlayer.getState()
    expect(player.queue[player.currentIndex].id).toBe('b')
    expect(player.playing).toBe(true)
    expect(player.currentTime).toBeGreaterThanOrEqual(40)
  })

  it('lists open devices and sends playback to one of them', async () => {
    useLivePlayback.setState({ devices: [{ deviceId: 'phone', deviceName: 'iPhone app', lastSeen: Date.now() }] })
    render(<PlayerBar/>)
    fireEvent.click(document.querySelector('.player-actions .device-button') as HTMLElement)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('This device')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: /iPhone app/ })) })
    expect(requests.map((request) => request.url)).toEqual(['/api/live-playback', '/api/live-playback/command'])
    expect(requests[1].body).toMatchObject({ targetDeviceId: 'phone', action: 'transfer' })
  })

  it('starts song radio from Now Playing and names it above the queue', async () => {
    usePlayer.setState({ nowPlayingOpen: true })
    render(<PlayerBar/>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start radio from Ana Ng' })) })
    expect(useRadio.getState().seed?.id).toBe('a')
    expect(screen.getByRole('button', { name: 'Start radio from Ana Ng' })).toHaveClass('active')
    await act(async () => { usePlayer.setState({ nowPlayingOpen: false, queueOpen: true }) })
    expect(screen.getByText('Radio · Ana Ng')).toBeInTheDocument()
    useRadio.setState({ seed: null })
  })

  it('swaps the artwork for lyrics, remembers that, and seeks from a lyric line', () => {
    usePlayer.setState({ nowPlayingOpen: true, currentTime: 33 })
    const { unmount } = render(<PlayerBar/>)
    fireEvent.click(screen.getByRole('button', { name: 'Show lyrics' }))
    expect(screen.getByRole('button', { name: 'Lyrics of Ana Ng at 33' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics of Ana Ng at 33' }))
    expect(usePlayer.getState().currentTime).toBe(12)
    unmount()
    render(<PlayerBar/>)
    expect(screen.getByRole('button', { name: 'Hide lyrics' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide lyrics' }))
    expect(window.localStorage.getItem('tomify-lyrics-open')).toBe('0')
  })
})
