import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddToPlaylist } from './AddToPlaylist'

const api = { playlists: vi.fn(), addToPlaylist: vi.fn(), createPlaylist: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
const shares = vi.hoisted(() => ({ loadPlaylistShares: vi.fn() }))
vi.mock('../lib/playlist-sharing', () => shares)
const collaborator = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), replace: vi.fn() }))
vi.mock('../lib/playlist-shares', async (original) => ({ ...await original<typeof import('../lib/playlist-shares')>(), collaboratorApi: collaborator }))

describe('AddToPlaylist', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset())
    api.playlists.mockResolvedValue([{ id: 'p1', name: 'Morning', owner: 'tom' }])
    shares.loadPlaylistShares.mockResolvedValue(null)
    collaborator.add.mockReset()
  })

  it('adds to someone else\'s playlist they let you edit, and not to ones you can only listen to', async () => {
    shares.loadPlaylistShares.mockResolvedValue({ accounts: [], sharedByMe: [], sharedWithMe: [{ kind: 'navidrome', playlistId: 'p9', owner: 'anna', name: 'Road trip', canEdit: true }, { kind: 'navidrome', playlistId: 'p8', owner: 'anna', name: 'Read only', canEdit: false }] })
    collaborator.add.mockResolvedValue(undefined)
    render(<AddToPlaylist songIds={['t1']} label="Istanbul"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Add Istanbul to a playlist' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Road trip · anna' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Track added to Road trip.')
    expect(collaborator.add).toHaveBeenCalledWith('p9', ['t1'])
    expect(api.addToPlaylist).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem', { name: /Read only/ })).not.toBeInTheDocument()
  })

  it('adds a track to one of your playlists', async () => {
    api.addToPlaylist.mockResolvedValue(undefined)
    render(<AddToPlaylist songIds={['t1']} label="Istanbul"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Add Istanbul to a playlist' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Morning' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Track added to Morning.')
    expect(api.addToPlaylist).toHaveBeenCalledWith('p1', ['t1'])
  })

  it('creates a new playlist holding the album tracks', async () => {
    api.createPlaylist.mockResolvedValue({ id: 'p2', name: 'Flood mix' })
    render(<AddToPlaylist songIds={['t1', 't2']} label="Flood" variant="button"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Add to playlist' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New playlist' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New playlist name' }), { target: { value: ' Flood mix ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('status')).toHaveTextContent('2 tracks added to Flood mix.')
    expect(api.createPlaylist).toHaveBeenCalledWith('Flood mix', ['t1', 't2'])
    expect(screen.getByRole('menuitem', { name: 'Flood mix' })).toBeInTheDocument()
  })

  it('reports a refused add', async () => {
    api.addToPlaylist.mockRejectedValue(new Error('Not allowed'))
    render(<AddToPlaylist songIds={['t1']} label="Istanbul"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Add Istanbul to a playlist' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Morning' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed')
  })
})
