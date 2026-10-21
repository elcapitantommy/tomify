import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { PlaylistFileImport } from './PlaylistFileImport'

const library = [
  { id: 's1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 197 },
  { id: 's2', title: 'Hysteria', artist: 'Muse', album: 'Absolution', duration: 227 },
]
const api = {
  search: vi.fn(async (query: string) => ({ artists: [], albums: [], tracks: library.filter((track) => query.toLowerCase().includes(track.title.toLowerCase())) })),
  createPlaylist: vi.fn(async () => ({ id: 'pl9', name: 'Road trip' })),
}
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
const recoveryAdd = vi.fn(async (input: unknown) => ({ item: input }))
vi.mock('../lib/recovery-api', () => ({ recoveryApi: { add: (input: unknown) => recoveryAdd(input) } }))

const file = (text: string, name = 'road trip.m3u8') => new File([text], name, { type: 'audio/x-mpegurl' })
const m3u = '#EXTM3U\n#PLAYLIST:Road trip\n#EXTINF:197,They Might Be Giants - Birdhouse in Your Soul\nTMBG/Flood/03.flac\n#EXTINF:227,Muse - Hysteria\n#EXTALB:Absolution\nMuse/Absolution/04.flac\n#EXTINF:240,Nobody - Not Here\n#EXTALB:Nowhere\nx.mp3\n'

function renderPage() {
  render(<MemoryRouter initialEntries={['/playlists/import/file']}><Routes><Route path="/playlists/import/file" element={<PlaylistFileImport/>}/><Route path="/playlists/:id" element={<p>Playlist page</p>}/></Routes></MemoryRouter>)
}
const choose = (contents: File) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [contents] } })

describe('Import a playlist file', () => {
  beforeEach(() => { api.search.mockClear(); api.createPlaylist.mockClear(); recoveryAdd.mockClear(); useAuth.setState({ isAdmin: false }) })
  afterEach(() => { useAuth.setState({ isAdmin: null }) })

  it('finds the songs in the library and saves the found ones as a new playlist', async () => {
    renderPage()
    choose(file(m3u))
    expect(await screen.findByText(/2 found · 1 not in your library/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toHaveValue('Road trip')
    expect(screen.queryByText(/to Recovery/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Hysteria' }))
    fireEvent.click(screen.getByRole('button', { name: /Create playlist \(1 song\)/ }))
    expect(await screen.findByText('Playlist page')).toBeInTheDocument()
    expect(api.createPlaylist).toHaveBeenCalledWith('Road trip', ['s1'])
  })

  it('lets an admin send the missing songs to Recovery', async () => {
    useAuth.setState({ isAdmin: true })
    renderPage()
    choose(file(m3u))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Add the 1 missing song to Recovery/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create playlist \(2 songs\)/ }))
    await waitFor(() => expect(recoveryAdd).toHaveBeenCalledWith({ artist: 'Nobody', title: 'Not Here', album: 'Nowhere', duration: 240 }))
    expect(api.createPlaylist).toHaveBeenCalledWith('Road trip', ['s1', 's2'])
  })

  it('explains a file with no songs in it', async () => {
    renderPage()
    choose(file('#EXTM3U\n#PLAYLIST:Empty\n'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No songs were found/)
  })
})
