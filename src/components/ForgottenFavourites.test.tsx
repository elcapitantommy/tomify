import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ForgottenFavourites } from './ForgottenFavourites'

vi.mock('./Artwork', () => ({ Artwork: () => null }))
const api = { albums: vi.fn(), album: vi.fn(), star: vi.fn(), unstar: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api, useOptionalApi: () => api }))

describe('Forgotten favourites', () => {
  it('shows well-played albums not heard for months, from the most-played list', async () => {
    api.albums.mockResolvedValue([
      { id: 'a', name: 'Origin of Symmetry', artist: 'Muse', playCount: 30, played: '2025-12-01T10:00:00Z' },
      { id: 'b', name: 'Drones', artist: 'Muse', playCount: 30, played: '2026-10-20T10:00:00Z' },
    ])
    render(<MemoryRouter><ForgottenFavourites now={new Date(2026, 9, 21)}/></MemoryRouter>)
    expect(await screen.findByText('Origin of Symmetry')).toBeInTheDocument()
    expect(screen.getByText(/Last played Dec 2025/)).toBeInTheDocument()
    expect(screen.queryByText('Drones')).toBeNull()
    expect(api.albums).toHaveBeenCalledWith('frequent', 300, expect.anything())
  })

  it('stays hidden when there is nothing to rediscover', async () => {
    api.albums.mockResolvedValue([])
    const { container } = render(<MemoryRouter><ForgottenFavourites/></MemoryRouter>)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
