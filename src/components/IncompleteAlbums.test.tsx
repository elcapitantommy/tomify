import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { completenessApi } from '../lib/completeness-api'
import { IncompleteAlbums } from './IncompleteAlbums'

vi.mock('../lib/completeness-api', () => ({ completenessApi: { overview: vi.fn() } }))

describe('IncompleteAlbums', () => {
  it('lists checked albums that came up short, with a link to each album', async () => {
    vi.mocked(completenessApi.overview).mockResolvedValue({ albums: [{ albumId: 'album-1', title: 'Flood', artist: 'They Might Be Giants', total: 19, present: 12, queued: 7, checkedAt: '2026-10-19 10:00:00' }] })
    render(<MemoryRouter><IncompleteAlbums/></MemoryRouter>)
    expect(await screen.findByText('They Might Be Giants · Flood')).toBeInTheDocument()
    expect(screen.getByText(/12 of 19 tracks when checked .* · 7 in Recovery/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Flood' })).toHaveAttribute('href', '/albums/album-1')
  })

  it('says when every checked album was complete', async () => {
    vi.mocked(completenessApi.overview).mockResolvedValue({ albums: [] })
    render(<MemoryRouter><IncompleteAlbums/></MemoryRouter>)
    expect(await screen.findByText(/Every album checked against MusicBrainz was complete/)).toBeInTheDocument()
  })
})
