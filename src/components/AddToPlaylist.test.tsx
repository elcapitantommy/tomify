import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddToPlaylist } from './AddToPlaylist'

const api = { playlists: vi.fn(), addToPlaylist: vi.fn(), createPlaylist: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

describe('AddToPlaylist', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset())
    api.playlists.mockResolvedValue([{ id: 'p1', name: 'Morning', owner: 'tom' }])
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
