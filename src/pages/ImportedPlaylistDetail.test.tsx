import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { CataloguePlaylist } from '../lib/catalogue-import'
import { NavidromeError } from '../lib/navidrome'
import type { Track } from '../types'
import { useAuth } from '../stores/auth'
import { ImportedPlaylistDetail } from './ImportedPlaylistDetail'

const moved: Track = { id: 'new-id', title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 }
const playlist: CataloguePlaylist = {
  id: 'imp-1', name: 'Spotify mix', provider: 'spotify', providerPlaylistId: 'sp1', sourceUrl: 'https://open.spotify.com/playlist/sp1', createdAt: '', updatedAt: '', counts: { total: 1, available: 1, missing: 0, review: 0, unavailable: 0 },
  items: [{ id: 'item-1', position: 0, status: 'available', title: 'Birdhouse in Your Soul - 2010 Remaster', artists: ['They Might Be Giants'], album: 'Flood', duration: 200, localTrackId: 'old-id', localTrack: { ...moved, id: 'old-id' } }],
}
const api = { song: vi.fn(async () => { throw new NavidromeError('Song not found', 70) }), search: vi.fn(async () => ({ artists: [], albums: [], tracks: [moved] })) }
const catalogue = vi.hoisted(() => ({ get: vi.fn(), resolve: vi.fn() }))

vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../lib/catalogue-api', () => ({ catalogueApi: catalogue }))
vi.mock('../lib/playlist-sharing', () => ({ loadPlaylistShares: async () => null, saveImportedPlaylistShares: vi.fn() }))

describe('ImportedPlaylistDetail', () => {
  it('re-matches an entry whose library track was moved and saves the new track', async () => {
    catalogue.get.mockResolvedValue({ playlist })
    catalogue.resolve.mockImplementation(async () => ({ playlist: { ...playlist, items: [{ ...playlist.items[0], localTrackId: 'new-id', localTrack: moved }] } }))
    render(<MemoryRouter initialEntries={['/playlists/imported/imp-1']}><Routes><Route path="/playlists/imported/:id" element={<ImportedPlaylistDetail/>}/></Routes></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Spotify mix' })).toBeInTheDocument()
    await waitFor(() => expect(catalogue.resolve).toHaveBeenCalledWith('imp-1', [{ id: 'item-1', localTrack: moved, matchConfidence: 98 }], false))
    expect(api.song).toHaveBeenCalledWith('old-id')
  })

  it('asks an administrator\'s session to queue entries still missing after a scheduled refresh', async () => {
    useAuth.setState({ isAdmin: true })
    const refreshed: CataloguePlaylist = { ...playlist, provenance: { autoRecovery: true }, items: [{ id: 'item-2', position: 0, status: 'missing', title: 'Particle Man', artists: ['They Might Be Giants'], album: 'Flood', recoveryId: null }] }
    api.search.mockResolvedValueOnce({ artists: [], albums: [], tracks: [] })
    catalogue.resolve.mockReset()
    catalogue.get.mockResolvedValue({ playlist: refreshed })
    catalogue.resolve.mockResolvedValue({ playlist: refreshed })
    render(<MemoryRouter initialEntries={['/playlists/imported/imp-1']}><Routes><Route path="/playlists/imported/:id" element={<ImportedPlaylistDetail/>}/></Routes></MemoryRouter>)
    await waitFor(() => expect(catalogue.resolve).toHaveBeenCalledWith('imp-1', [], true))
    useAuth.setState({ isAdmin: null })
  })
})
