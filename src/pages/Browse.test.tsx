import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '../stores/player'
import { Browse, DecadeDetail, GenreDetail } from './Browse'

let user = 0
const api = {
  session: { username: 'tom' },
  genreList: vi.fn(async () => [{ name: 'Rock', albumCount: 12, songCount: 120 }, { name: 'Jazz', albumCount: 2, songCount: 20 }]),
  allAlbums: vi.fn(async () => [{ id: 'al1', name: 'Lincoln', artist: 'TMBG', year: 1988 }, { id: 'al2', name: 'Flood', artist: 'TMBG', year: 1990 }]),
  albumsByGenre: vi.fn(async () => [{ id: 'al1', name: 'Lincoln', artist: 'TMBG', year: 1988 }]),
  albumsByYears: vi.fn(async () => [{ id: 'al1', name: 'Lincoln', artist: 'TMBG', year: 1988 }]),
  randomSongs: vi.fn(async () => [{ id: 's1', title: 'Ana Ng', artist: 'TMBG', album: 'Lincoln' }]),
}
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../components/Artwork', () => ({ Artwork: () => null }))

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/browse" element={<Browse/>}/><Route path="/browse/genre/:name" element={<GenreDetail/>}/><Route path="/browse/decade/:start" element={<DecadeDetail/>}/></Routes></MemoryRouter>)
}

describe('Browse', () => {
  beforeEach(() => { api.session.username = `user${++user}`; vi.clearAllMocks(); usePlayer.setState({ queue: [], currentIndex: -1, playing: false, shuffle: false }) })

  it('shows decade and genre tiles from the library', async () => {
    renderAt('/browse')
    expect(await screen.findByRole('link', { name: /1980s/ })).toHaveAttribute('href', '/browse/decade/1980')
    expect(screen.getByRole('link', { name: /1990s/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Rock\s*12 albums/ })).toHaveAttribute('href', '/browse/genre/Rock')
  })

  it('lists a genre\'s albums and shuffles its songs', async () => {
    renderAt('/browse/genre/Rock')
    expect(await screen.findByText('Lincoln')).toBeInTheDocument()
    expect(api.albumsByGenre).toHaveBeenCalledWith('Rock', expect.anything())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Shuffle play' })) })
    expect(api.randomSongs).toHaveBeenCalledWith({ size: 200, genre: 'Rock' })
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['s1'])
  })

  it('lists a decade\'s albums and shuffles songs from those years', async () => {
    renderAt('/browse/decade/1980')
    expect(await screen.findByText('Lincoln')).toBeInTheDocument()
    expect(api.albumsByYears).toHaveBeenCalledWith(1980, 1989, expect.anything())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Shuffle play' })) })
    expect(api.randomSongs).toHaveBeenCalledWith({ size: 200, fromYear: 1980, toYear: 1989 })
  })
})
