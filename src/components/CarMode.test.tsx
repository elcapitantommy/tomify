import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useLivePlayback } from '../stores/livePlayback'
import { useCarMode } from '../stores/carMode'
import { CarMode } from './CarMode'

vi.mock('./Artwork', () => ({ Artwork: () => null }))
const api = { star: vi.fn(async () => undefined), unstar: vi.fn(async () => undefined) }
vi.mock('../lib/api-context', () => ({ useApi: () => api, useOptionalApi: () => api }))

const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]

describe('CarMode', () => {
  let release: ReturnType<typeof vi.fn>
  beforeEach(() => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: tracks, currentIndex: 0, playing: false, currentTime: 50, duration: 200, shuffle: false })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0 })
    release = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn(async () => ({ release })) } })
  })
  afterEach(() => { useCarMode.getState().setOpen(false); delete (navigator as unknown as { wakeLock?: unknown }).wakeLock })

  it('shows the song in big type with large controls and keeps the screen on', async () => {
    useCarMode.getState().setOpen(true)
    const { unmount } = render(<CarMode/>)
    await act(async () => {})
    expect(screen.getByRole('dialog', { name: 'Car mode' })).toHaveTextContent('Ana Ng')
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(usePlayer.getState().playing).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }))
    expect(usePlayer.getState().currentIndex).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
    expect(usePlayer.getState().shuffle).toBe(true)
    expect((navigator as unknown as { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock.request).toHaveBeenCalledWith('screen')
    fireEvent.click(screen.getByRole('button', { name: 'Leave car mode' }))
    expect(screen.queryByRole('dialog', { name: 'Car mode' })).not.toBeInTheDocument()
    expect(release).toHaveBeenCalled()
    expect(window.localStorage.getItem('tomify-car-mode')).toBe('0')
    unmount()
  })

  it('stays hidden when nothing is queued', () => {
    usePlayer.setState({ queue: [], currentIndex: -1 })
    useCarMode.getState().setOpen(true)
    render(<CarMode/>)
    expect(screen.queryByRole('dialog', { name: 'Car mode' })).not.toBeInTheDocument()
  })
})
