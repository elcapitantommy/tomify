import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '../stores/player'
import { useLivePlayback } from '../stores/livePlayback'
import { useFavourites } from '../stores/favourites'
import { useAuth } from '../stores/auth'
import { KeyboardShortcuts } from './KeyboardShortcuts'

const api = { star: vi.fn(async () => undefined), unstar: vi.fn(async () => undefined) }
vi.mock('../lib/api-context', () => ({ useOptionalApi: () => api }))

const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]

function renderShortcuts() {
  return render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<><KeyboardShortcuts/><input aria-label="Name"/></>}/><Route path="/search" element={<p>Search page</p>}/></Routes></MemoryRouter>)
}

describe('KeyboardShortcuts', () => {
  beforeEach(() => {
    usePlayer.setState({ queue: tracks, currentIndex: 0, playing: false, currentTime: 30, duration: 200, volume: 0.5, muted: false, queueOpen: false, nowPlayingOpen: false })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0 })
    useFavourites.setState({ overrides: {}, version: 0 })
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
  })
  afterEach(() => { api.star.mockClear(); api.unstar.mockClear() })

  it('plays, skips, seeks and changes volume from the keyboard', () => {
    renderShortcuts()
    fireEvent.keyDown(window, { key: ' ' })
    expect(usePlayer.getState().playing).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(usePlayer.getState().currentTime).toBe(40)
    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true })
    expect(usePlayer.getState().volume).toBe(0.6)
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    expect(usePlayer.getState().currentIndex).toBe(1)
    fireEvent.keyDown(window, { key: 'm' })
    expect(usePlayer.getState().muted).toBe(true)
  })

  it('does nothing while typing in a box', () => {
    renderShortcuts()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: ' ' })
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('likes the song playing with L', async () => {
    renderShortcuts()
    fireEvent.keyDown(window, { key: 'l' })
    expect(useFavourites.getState().overrides.a).toBe(true)
    await vi.waitFor(() => expect(api.star).toHaveBeenCalledWith('a'))
  })

  it('opens search with / and lists the shortcuts with ?', () => {
    renderShortcuts()
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent('Play or pause')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: '/' })
    expect(screen.getByText('Search page')).toBeInTheDocument()
  })

  it('controls the other device when playback is there', () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    useLivePlayback.setState({ snapshot: { deviceId: 'desktop', deviceName: 'Windows · Chrome', queue: tracks, currentIndex: 0, playing: true, currentTime: 40, duration: 200, volume: 0.8, muted: false, shuffle: false, repeat: 'off', updatedAt: Date.now(), revision: 3 }, devices: [{ deviceId: 'desktop', deviceName: 'Windows · Chrome', lastSeen: Date.now() }] })
    renderShortcuts()
    fireEvent.keyDown(window, { key: ' ' })
    expect(usePlayer.getState().playing).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ targetDeviceId: 'desktop', action: 'pause' })
    vi.unstubAllGlobals()
  })
})
