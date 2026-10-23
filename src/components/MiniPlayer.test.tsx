import { act, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useLivePlayback } from '../stores/livePlayback'
import { restoreDesktopWindow, useMiniPlayer } from '../stores/miniPlayer'
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
  afterEach(() => { useMiniPlayer.setState({ window: null, compact: false }); delete (window as unknown as { __TAURI__?: unknown }).__TAURI__; document.querySelectorAll('iframe').forEach((frame) => frame.remove()); delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture })

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

  describe('in the Windows app', () => {
    const invoke = vi.fn<(command: string) => Promise<undefined>>()
    beforeEach(() => {
      invoke.mockReset()
      invoke.mockResolvedValue(undefined)
      delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
      ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } }
    })

    it('turns the app window into the mini player and back, without a second window', async () => {
      const { getByRole, container } = render(<><MiniPlayerButton/><MiniPlayerHost/></>)
      await act(async () => { fireEvent.click(getByRole('button', { name: 'Pop out mini player' })) })
      expect(invoke).toHaveBeenCalledWith('enter_mini_player')
      const mini = container.querySelector('.desktop-mini-player') as HTMLElement
      expect(mini.getAttribute('data-tauri-drag-region')).toBe('deep')
      expect(within(mini).getByText('Ana Ng').textContent).toBe('Ana Ng')
      expect(document.body.classList.contains('mini-player-window')).toBe(true)
      fireEvent.click(within(mini).getByRole('button', { name: 'Play' }))
      expect(usePlayer.getState().playing).toBe(true)
      act(() => { fireEvent.click(within(mini).getByRole('button', { name: 'Back to full window' })) })
      expect(invoke).toHaveBeenLastCalledWith('exit_mini_player')
      expect(container.querySelector('.desktop-mini-player')).toBeNull()
      expect(document.body.classList.contains('mini-player-window')).toBe(false)
      expect(getByRole('button', { name: 'Pop out mini player' }).getAttribute('aria-pressed')).toBe('false')
    })

    it('stays a full window when the app refuses', async () => {
      invoke.mockRejectedValueOnce(new Error('not allowed'))
      const { getByRole, container } = render(<><MiniPlayerButton/><MiniPlayerHost/></>)
      await act(async () => { fireEvent.click(getByRole('button', { name: 'Pop out mini player' })) })
      expect(useMiniPlayer.getState().compact).toBe(false)
      expect(container.querySelector('.desktop-mini-player')).toBeNull()
    })

    it('gives the window back when Tomify unmounts, and on every page load', async () => {
      const { getByRole, unmount } = render(<><MiniPlayerButton/><MiniPlayerHost/></>)
      await act(async () => { fireEvent.click(getByRole('button', { name: 'Pop out mini player' })) })
      unmount()
      expect(invoke).toHaveBeenLastCalledWith('exit_mini_player')
      invoke.mockClear()
      restoreDesktopWindow()
      expect(invoke).toHaveBeenCalledWith('exit_mini_player')
    })
  })
})
