import { act, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useLivePlayback } from '../stores/livePlayback'
import { useMiniPlayer } from '../stores/miniPlayer'
import { MiniPlayerButton, MiniPlayerHost } from './MiniPlayer'

vi.mock('./Artwork', () => ({ Artwork: () => null }))
const api = { star: vi.fn(), unstar: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api, useOptionalApi: () => api }))

const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]

// A real window to render into: an iframe's.
function fakeWindow() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const opened = frame.contentWindow!
  opened.close = vi.fn(() => { opened.dispatchEvent(new Event('pagehide')) })
  return opened as Window & { close: ReturnType<typeof vi.fn> }
}

describe('Mini player', () => {
  let opened: ReturnType<typeof fakeWindow>
  beforeEach(() => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: tracks, currentIndex: 0, playing: false, currentTime: 50, duration: 200 })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0 })
    document.documentElement.setAttribute('data-theme', 'light')
    opened = fakeWindow()
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: vi.fn(async () => opened), window: null } })
  })
  afterEach(() => { useMiniPlayer.setState({ window: null }); document.querySelectorAll('iframe').forEach((frame) => frame.remove()); delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture })

  it('pops out a small window with the song and working controls, in the same theme', async () => {
    const { getByRole } = render(<><MiniPlayerButton/><MiniPlayerHost/></>)
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Pop out mini player' })) })
    const mini = within(opened.document.body)
    expect(mini.getByText('Ana Ng').textContent).toBe('Ana Ng')
    expect(opened.document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(opened.document.body.classList.contains('mini-player-window')).toBe(true)
    fireEvent.click(mini.getByRole('button', { name: 'Play' }))
    expect(usePlayer.getState().playing).toBe(true)
    fireEvent.click(mini.getByRole('button', { name: 'Next track' }))
    expect(mini.getByText('Purple Toupee').textContent).toBe('Purple Toupee')
    act(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await act(async () => {})
    expect(opened.document.documentElement.getAttribute('data-theme')).toBe('dark')
    act(() => { fireEvent.click(getByRole('button', { name: 'Close mini player' })) })
    expect(opened.close).toHaveBeenCalled()
    expect(useMiniPlayer.getState().window).toBeNull()
  })

  it('has no button where the browser cannot pop out a window', () => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
    const { queryByRole } = render(<MiniPlayerButton/>)
    expect(queryByRole('button', { name: /mini player/ })).toBeNull()
  })
})
