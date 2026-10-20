import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtistAbout, ArtistPopular } from './ArtistAbout'

const api = { session: { username: 'tom' }, artistInfo: vi.fn(), topSongs: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('./TrackList', () => ({ TrackList: ({ tracks }: { tracks: { title: string }[] }) => <ol>{tracks.map((track) => <li key={track.title}>{track.title}</li>)}</ol> }))
vi.mock('./Artwork', () => ({ Artwork: () => null }))

let artistCounter = 0
const artist = () => ({ id: `ar${++artistCounter}`, name: 'They Might Be Giants' })

describe('artist page extras', () => {
  beforeEach(() => { api.artistInfo.mockReset(); api.topSongs.mockReset() })

  it('lists five popular songs and shows the rest on request', async () => {
    api.topSongs.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, title: `Song ${index + 1}` })))
    render(<ArtistPopular artist={artist()}/>)
    expect(await screen.findByText('Song 5')).toBeInTheDocument()
    expect(screen.queryByText('Song 6')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText('Song 8')).toBeInTheDocument()
  })

  it('shows the biography and similar artists in the library', async () => {
    api.artistInfo.mockResolvedValue({ biography: ['Formed in 1982.', 'Still touring.'], lastFmUrl: 'https://www.last.fm/music/TMBG', similar: [{ id: 'ar9', name: 'Ween', albumCount: 3 }] })
    render(<MemoryRouter><ArtistAbout artist={artist()}/></MemoryRouter>)
    expect(await screen.findByText('Formed in 1982.')).toBeInTheDocument()
    expect(screen.queryByText('Still touring.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Read more' }))
    expect(screen.getByText('Still touring.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Last\.fm/ })).toHaveAttribute('href', 'https://www.last.fm/music/TMBG')
    expect(screen.getByRole('link', { name: /Ween/ })).toHaveAttribute('href', '/artists/ar9')
  })

  it('shows nothing when Navidrome has no artist information', async () => {
    api.artistInfo.mockRejectedValue(new Error('no agent'))
    api.topSongs.mockResolvedValue([])
    const { container } = render(<MemoryRouter><ArtistPopular artist={artist()}/><ArtistAbout artist={artist()}/></MemoryRouter>)
    await vi.waitFor(() => expect(api.artistInfo).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container).toBeEmptyDOMElement()
  })
})
