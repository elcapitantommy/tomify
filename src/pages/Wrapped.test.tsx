import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Wrapped } from './Wrapped'
import { listeningStatsApi, type Wrapped as WrappedData } from '../lib/listening-stats'

const api = { createPlaylist: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../lib/listening-stats', async (original) => {
  const actual = await original<typeof import('../lib/listening-stats')>()
  return { ...actual, listeningStatsApi: { load: vi.fn(), wrapped: vi.fn() } }
})

const recap: WrappedData = {
  year: 2026, plays: 420, skips: 20, seconds: 90_000,
  artists: [{ artist: 'Muse', artistId: 'ar1', plays: 80, seconds: 18_000 }],
  albums: [{ album: 'Origin of Symmetry', albumId: 'al1', artist: 'Muse', plays: 40, seconds: 9000 }],
  tracks: [{ trackId: 't1', title: 'Bliss', artist: 'Muse', albumId: 'al1', plays: 12, seconds: 2800 }],
  genres: [{ genre: 'Rock', plays: 300, seconds: 60_000 }],
  months: [{ month: 1, plays: 20, seconds: 4000 }, { month: 3, plays: 200, seconds: 50_000 }],
  firstTrack: { trackId: 't9', title: 'New Born', artist: 'Muse', albumId: 'al1', playedAt: new Date(2026, 0, 1, 10).getTime() },
  mostRepeated: { trackId: 't1', title: 'Bliss', artist: 'Muse', albumId: 'al1', day: '2026-03-14', plays: 9 },
  newArtistCount: 7, newArtists: [{ artist: 'Wet Leg', artistId: 'ar7', plays: 15, seconds: 3000 }],
  playlist: ['t1', 't9'],
  previous: { year: 2025, plays: 300, seconds: 60_000 },
}

const renderYear = (year: number) => render(<MemoryRouter initialEntries={[`/wrapped/${year}`]}><Routes><Route path="/wrapped/:year" element={<Wrapped/>}/></Routes></MemoryRouter>)

describe('Wrapped', () => {
  beforeEach(() => { api.createPlaylist.mockReset().mockResolvedValue({ id: 'p1', name: 'x' }) })

  it('shows the year in review and saves the year playlist', async () => {
    vi.mocked(listeningStatsApi.wrapped).mockResolvedValue(recap)
    renderYear(2026)
    expect(await screen.findByText('1,500')).toBeInTheDocument()
    expect(listeningStatsApi.wrapped).toHaveBeenCalledWith(2026)
    expect(screen.getByText('50% more listening than 2025 (17 hours).')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /biggest month was March/ })).toBeInTheDocument()
    expect(screen.getByText('New Born')).toBeInTheDocument()
    expect(screen.getByText(/9 plays on (14 March|March 14)/)).toBeInTheDocument()
    expect(screen.getByText('Rock')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Wet Leg' })).toHaveAttribute('href', '/artists/ar7')
    fireEvent.click(screen.getByRole('button', { name: /Save as playlist/ }))
    expect(await screen.findByText('Saved to your playlists')).toBeInTheDocument()
    expect(api.createPlaylist).toHaveBeenCalledWith('Your 2026 in Tomify', ['t1', 't9'])
  })

  it('says so when a year has no plays', async () => {
    vi.mocked(listeningStatsApi.wrapped).mockResolvedValue({ ...recap, plays: 0, seconds: 0, previous: null })
    renderYear(2024)
    expect(await screen.findByText('No plays in 2024')).toBeInTheDocument()
  })
})
