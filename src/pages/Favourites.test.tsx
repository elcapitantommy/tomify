import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResults } from '../types'
import { useFavourites } from '../stores/favourites'
import { Favourites } from './Favourites'

const flood = { id: 'al1', name: 'Flood', artist: 'They Might Be Giants', starred: '2024-01-01T00:00:00Z' }
const istanbul = { id: 't2', title: 'Istanbul', artist: 'They Might Be Giants', album: 'Flood', starred: '2024-01-01T00:00:00Z' }
const birdhouse = { id: 't1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', starred: '2024-02-01T00:00:00Z' }
const api = { starred: vi.fn<() => Promise<SearchResults>>(), star: vi.fn(async () => {}), unstar: vi.fn(async () => {}), coverArtUrl: () => '' }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../components/Artwork', () => ({ Artwork: () => null }))

const renderPage = () => render(<MemoryRouter><Favourites/></MemoryRouter>)

describe('Favourites', () => {
  beforeEach(() => {
    useFavourites.setState({ overrides: {}, version: 0 })
    api.starred.mockReset()
  })

  it('drops an unstarred track and album at once and refetches after the server confirms', async () => {
    api.starred.mockResolvedValueOnce({ artists: [], albums: [flood], tracks: [istanbul] }).mockResolvedValue({ artists: [], albums: [], tracks: [] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Istanbul from favourites' }))
    expect(screen.queryByText('Istanbul')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Flood from favourites' }))
    expect(api.unstar).toHaveBeenCalledWith('al1', 'album')
    expect(await screen.findByText('No favourites yet')).toBeInTheDocument()
    await waitFor(() => expect(api.starred).toHaveBeenCalledTimes(2))
  })

  it('shows music starred elsewhere without a reload', async () => {
    api.starred.mockResolvedValueOnce({ artists: [], albums: [], tracks: [istanbul] }).mockResolvedValue({ artists: [], albums: [], tracks: [istanbul, birdhouse] })
    renderPage()
    expect(await screen.findByText('Istanbul')).toBeInTheDocument()
    expect(screen.queryByText('Birdhouse in Your Soul')).not.toBeInTheDocument()
    act(() => { useFavourites.getState().setStarred('t1', true); useFavourites.getState().confirm() })
    expect(await screen.findByText('Birdhouse in Your Soul')).toBeInTheDocument()
    expect(screen.getByText('Istanbul')).toBeInTheDocument()
  })
})
