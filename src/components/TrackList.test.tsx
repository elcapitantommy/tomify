import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'
import { useFavourites } from '../stores/favourites'
import { TrackList } from './TrackList'

const api = { star: vi.fn(), unstar: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

const tracks: Track[] = [
  { id: 't1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood' },
  { id: 't2', title: 'Istanbul', artist: 'They Might Be Giants', album: 'Flood', starred: '2024-01-01T00:00:00Z' },
]

describe('TrackList favourite toggle', () => {
  beforeEach(() => {
    useFavourites.setState({ overrides: {}, version: 0 })
    api.star.mockReset(); api.unstar.mockReset()
  })

  it('stars a track optimistically and confirms the change', async () => {
    let finish!: () => void
    api.star.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    render(<TrackList tracks={tracks}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Add Birdhouse in Your Soul to favourites' }))
    expect(screen.getByRole('button', { name: 'Remove Birdhouse in Your Soul from favourites' })).toBeInTheDocument()
    expect(api.star).toHaveBeenCalledWith('t1', 'song')
    expect(useFavourites.getState().version).toBe(0)
    finish()
    await waitFor(() => expect(useFavourites.getState().version).toBe(1))
  })

  it('reverts an unstar the server refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.unstar.mockRejectedValue(new Error('offline'))
    render(<TrackList tracks={tracks}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Istanbul from favourites' }))
    expect(screen.getByRole('button', { name: 'Add Istanbul to favourites' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remove Istanbul from favourites' })).toBeInTheDocument()
    expect(api.unstar).toHaveBeenCalledWith('t2', 'song')
    expect(useFavourites.getState().version).toBe(0)
  })
})
