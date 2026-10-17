import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Playlist } from '../types'
import { PlaylistDetail } from './PlaylistDetail'

const playlist: Playlist = { id: 'p1', name: 'Morning', owner: 'tom', entry: [
  { id: 'a', title: 'Alpha', artist: 'A', album: 'X' }, { id: 'b', title: 'Bravo', artist: 'B', album: 'X' }, { id: 'c', title: 'Charlie', artist: 'C', album: 'X' },
] }
const api = { playlist: vi.fn(), ownsPlaylist: vi.fn(() => true), replacePlaylistTracks: vi.fn(), removeFromPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(), playlists: vi.fn(async () => []), star: vi.fn(), unstar: vi.fn() }
const sharing = vi.hoisted(() => ({ loadPlaylistShares: vi.fn(), saveNavidromePlaylistShares: vi.fn() }))
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../lib/playlist-sharing', () => sharing)

function renderPage() {
  render(<MemoryRouter initialEntries={['/playlists/p1']}><Routes><Route path="/playlists/:id" element={<PlaylistDetail/>}/><Route path="/playlists" element={<h1>All playlists</h1>}/></Routes></MemoryRouter>)
}
async function startEditing() { renderPage(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' })) }

describe('PlaylistDetail editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.playlist.mockResolvedValue(playlist)
    api.ownsPlaylist.mockReturnValue(true)
    sharing.loadPlaylistShares.mockResolvedValue({ accounts: ['anna'], sharedWithMe: [], sharedByMe: [{ kind: 'navidrome', playlistId: 'p1', sharedWith: ['anna'] }] })
  })

  it('moves a track down and saves the new order', async () => {
    api.replacePlaylistTracks.mockResolvedValue(undefined)
    await startEditing()
    fireEvent.click(screen.getByRole('button', { name: 'Move Alpha down' }))
    expect(api.replacePlaylistTracks).toHaveBeenCalledWith('p1', ['b', 'a', 'c'])
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Bravo'))
    expect(screen.getByRole('button', { name: 'Move Bravo up' })).toBeDisabled()
  })

  it('puts a removed track back when the server refuses', async () => {
    api.removeFromPlaylist.mockRejectedValue(new Error('Server said no'))
    await startEditing()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bravo from playlist' }))
    expect(api.removeFromPlaylist).toHaveBeenCalledWith('p1', [1])
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('renames the playlist', async () => {
    api.renamePlaylist.mockResolvedValue(undefined)
    await startEditing()
    fireEvent.change(screen.getByRole('textbox', { name: 'Playlist name' }), { target: { value: 'Evening' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByRole('heading', { name: 'Evening' })).toBeInTheDocument()
    expect(api.renamePlaylist).toHaveBeenCalledWith('p1', 'Evening')
  })

  it('unshares, then deletes the playlist after confirmation', async () => {
    sharing.saveNavidromePlaylistShares.mockResolvedValue([])
    api.deletePlaylist.mockResolvedValue(undefined)
    await startEditing()
    fireEvent.click(screen.getByRole('button', { name: 'Delete playlist' }))
    expect(api.deletePlaylist).not.toHaveBeenCalled()
    const buttons = screen.getAllByRole('button', { name: 'Delete playlist' })
    fireEvent.click(buttons[buttons.length - 1])
    expect(await screen.findByRole('heading', { name: 'All playlists' })).toBeInTheDocument()
    expect(sharing.saveNavidromePlaylistShares).toHaveBeenCalledWith(api, 'p1', [])
    expect(api.deletePlaylist).toHaveBeenCalledWith('p1')
  })

  it('offers no editing on a playlist shared with you', async () => {
    api.ownsPlaylist.mockReturnValue(false)
    sharing.loadPlaylistShares.mockResolvedValue({ accounts: [], sharedWithMe: [{ kind: 'navidrome', playlistId: 'p1', owner: 'anna', name: 'Morning' }], sharedByMe: [] })
    api.playlist.mockResolvedValue({ ...playlist, owner: 'anna' })
    renderPage()
    expect(await screen.findByText('Shared by anna')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })
})
