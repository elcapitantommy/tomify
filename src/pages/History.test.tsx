import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { History } from './History'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'

vi.mock('../components/Artwork', () => ({ Artwork: () => <span/> }))

const today = new Date(); today.setHours(10, 0, 0, 0)
const event = (id: number, minutesAgo: number, extra = {}) => ({ id, trackId: `t${id}`, albumId: 'al', artistId: 'ar', title: `Song ${id}`, artist: 'Artist', album: 'Album', durationSeconds: 200, listenedSeconds: 200, completed: true, skipped: false, playedAt: today.getTime() - minutesAgo * 60_000, device: 'iPhone', ...extra })

describe('History', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.getState().clearQueue()
    try { window.localStorage.clear() } catch { /* storage unavailable */ }
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists plays by day, replays from any of them and loads older plays', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [event(3, 1), event(2, 5, { skipped: true, completed: false }), event(1, 9)], next: 'cursor-1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{ ...event(0, 0), playedAt: today.getTime() - 3 * 86_400_000 }], next: null })))
    render(<MemoryRouter><History/></MemoryRouter>)
    const day = (await screen.findByRole('heading', { name: 'Today' })).closest('section')!
    expect(within(day).getAllByRole('listitem')).toHaveLength(3)
    expect(within(day).getByText('Skipped')).toBeInTheDocument()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/listening/history')
    expect(fetchMock.mock.calls[0][1].headers['x-tomify-user']).toBe('tom')

    fireEvent.click(screen.getByRole('button', { name: 'Play Song 2 and what came after it' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['t2', 't3'])

    fireEvent.click(screen.getByRole('button', { name: 'Show older plays' }))
    expect(await screen.findByText('Song 0')).toBeInTheDocument()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/listening/history?before=cursor-1')
    expect(screen.queryByRole('button', { name: 'Show older plays' })).not.toBeInTheDocument()
  })

  it('hides skipped songs when asked, and remembers it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events: [event(2, 1, { skipped: true, completed: false }), event(1, 5)], next: null })))
    render(<MemoryRouter><History/></MemoryRouter>)
    expect(await screen.findByText('Song 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide skipped songs' }))
    expect(screen.queryByText('Song 2')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('tomify-history-hide-skipped')).toBe('1')
  })

  it('explains an empty history and a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [], next: null })))
    const { unmount } = render(<MemoryRouter><History/></MemoryRouter>)
    expect(await screen.findByText('Nothing played yet')).toBeInTheDocument()
    unmount()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'listening-store-unavailable' }), { status: 503 }))
    render(<MemoryRouter><History/></MemoryRouter>)
    expect(await screen.findByText('listening-store-unavailable')).toBeInTheDocument()
  })
})
