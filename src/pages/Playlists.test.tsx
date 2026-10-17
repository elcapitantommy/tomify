import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Playlists } from './Playlists'

const api = { playlists: vi.fn(async () => []), createPlaylist: vi.fn(async () => ({ id: 'p7', name: 'Sunday' })) }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../lib/catalogue-api', () => ({ catalogueApi: { list: async () => ({ playlists: [] }) } }))
vi.mock('../lib/playlist-sharing', () => ({ loadPlaylistShares: async () => null }))

describe('Playlists', () => {
  it('creates a new playlist and opens it', async () => {
    render(<MemoryRouter initialEntries={['/playlists']}><Routes><Route path="/playlists" element={<Playlists/>}/><Route path="/playlists/:id" element={<h1>Opened playlist</h1>}/></Routes></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'New playlist' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New playlist name' }), { target: { value: 'Sunday' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('heading', { name: 'Opened playlist' })).toBeInTheDocument()
    expect(api.createPlaylist).toHaveBeenCalledWith('Sunday')
  })
})
