import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'
import { useFavourites } from '../stores/favourites'
import { TrackList } from './TrackList'
import { usePlayer } from '../stores/player'
import { useBookmarks } from '../stores/bookmarks'

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

describe('TrackList selecting several songs', () => {
  const three: Track[] = [...tracks, { id: 't3', title: 'Dead', artist: 'They Might Be Giants', album: 'Flood' }]
  beforeEach(() => { usePlayer.setState({ queue: [], currentIndex: 0, playing: false }) })

  it('ticks songs, shift-ticks a run, and plays just those in list order', () => {
    render(<TrackList tracks={three}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.getByRole('toolbar', { name: 'Selected songs' })).toHaveTextContent('Tick songs to select them')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dead' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Birdhouse in Your Soul' }), { shiftKey: true })
    expect(screen.getByRole('toolbar')).toHaveTextContent('3 songs selected')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Istanbul' }))
    expect(screen.getByRole('toolbar')).toHaveTextContent('2 songs selected')
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['t1', 't3'])
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('ticks a song by its title instead of playing it, and selects all', () => {
    render(<TrackList tracks={three}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByText('Istanbul'))
    expect(usePlayer.getState().queue).toEqual([])
    expect(screen.getByRole('checkbox', { name: 'Select Istanbul' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('toolbar')).toHaveTextContent('3 songs selected')
    fireEvent.click(screen.getByRole('button', { name: 'Stop selecting' }))
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('has no Select button when selecting is turned off or there is one song', () => {
    const { rerender } = render(<TrackList tracks={three} selectable={false}/>)
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
    rerender(<TrackList tracks={[three[0]]}/>)
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
  })
})

describe('TrackList saved place in long tracks', () => {
  it('shows how far into a long track you got', () => {
    useBookmarks.setState({ positions: { set: 900, t1: 60 } })
    render(<TrackList tracks={[{ id: 'set', title: 'Live at Wembley', artist: 'Queen', album: 'Live', duration: 3600 }, tracks[0]]}/>)
    const line = screen.getByRole('img', { name: 'Resume at 15:00' })
    expect(line.firstElementChild).toHaveStyle({ width: '25%' })
    expect(screen.getAllByRole('img', { name: /Resume at/ })).toHaveLength(1)
    useBookmarks.setState({ positions: {} })
  })
})
