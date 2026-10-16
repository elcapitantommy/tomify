import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Album, Track } from '../types'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { useAuth } from '../stores/auth'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { AlbumDetail } from './AlbumDetail'

const album: Album & { song: Track[] } = { id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', year: 1990, song: [{ id: 'track-1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 }] }
const api = { session: { username: 'guest' }, album: vi.fn(async () => album), albums: vi.fn(async () => [album]), artist: vi.fn(), coverArtUrl: () => 'https://music.example/cover.jpg' }

vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../components/AlbumCompleteness', () => ({ AlbumCompleteness: () => <p>completeness check</p> }))
vi.mock('../components/AlbumArtworkPicker', () => ({ AlbumArtworkPicker: ({ searchOnOpen }: { searchOnOpen?: boolean }) => <p>artwork picker{searchOnOpen ? ' searching' : ''}</p> }))
vi.mock('../components/TrackList', () => ({ TrackList: () => null }))

function renderAlbum() {
  return render(<MemoryRouter initialEntries={['/album/album-1']}><Routes><Route path="/album/:id" element={<AlbumDetail/>}/></Routes></MemoryRouter>)
}

describe('AlbumDetail admin tools', () => {
  beforeEach(() => {
    useReleaseMetadata.setState({ overrides: { 'album-1': { albumId: 'album-1', releaseType: 'album', source: 'musicbrainz' } }, cloudStatus: 'cloud' } as never)
    useAlbumArtwork.setState({ overrides: {}, status: 'ready', providers: ['apple', 'deezer'] })
  })

  it('gives administrators metadata editing, the completeness check and click-to-replace artwork', async () => {
    useAuth.setState({ isAdmin: true })
    renderAlbum()
    expect(await screen.findByRole('button', { name: 'Edit metadata' })).toBeInTheDocument()
    expect(await screen.findByText('completeness check')).toBeInTheDocument()
    expect(screen.queryByText(/artwork picker/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change album artwork' }))
    expect(screen.getByText('artwork picker searching')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close album artwork options' }))
    expect(screen.queryByText(/artwork picker/)).not.toBeInTheDocument()
  })

  it('hides metadata editing, the completeness check and artwork replacement from other users', async () => {
    useAuth.setState({ isAdmin: false })
    renderAlbum()
    expect(await screen.findByRole('heading', { name: 'Flood' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit metadata' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change album artwork' })).not.toBeInTheDocument()
    expect(screen.queryByText('completeness check')).not.toBeInTheDocument()
  })
})
