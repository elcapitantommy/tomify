import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { AlbumArtworkPicker } from './AlbumArtworkPicker'

const album = { id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', year: 1990 }
const candidate = { id: 'apple:1', provider: 'apple' as const, providerLabel: 'Apple', providerId: '1', url: 'https://is1.mzstatic.com/flood.jpg', confidence: 97, album: 'Flood', width: 1200, height: 1200 }

describe('AlbumArtworkPicker', () => {
  const lookup = vi.fn()
  const select = vi.fn()
  const upload = vi.fn()
  beforeEach(() => {
    upload.mockReset().mockResolvedValue(undefined)
    lookup.mockReset().mockResolvedValue({ candidates: [candidate], query: { album: 'Flood', artist: 'They Might Be Giants' }, searched: ['apple', 'deezer'], failed: [] })
    select.mockReset().mockResolvedValue(undefined)
    useAlbumArtwork.setState({ overrides: {}, status: 'ready', providers: ['apple', 'deezer'], lookup, select, upload })
  })

  it('searches for replacement artwork straight away when opened from the album artwork', async () => {
    const onClose = vi.fn()
    render(<AlbumArtworkPicker album={album} searchOnOpen onClose={onClose}/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Use Apple artwork from Flood' }))
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith('album-1', candidate)
    fireEvent.click(screen.getByRole('button', { name: 'Close album artwork options' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('uploads an image chosen from the device', async () => {
    render(<AlbumArtworkPicker album={album}/>)
    expect(screen.getByRole('button', { name: /Upload from device/ })).toBeInTheDocument()
    const file = new File(['cover'], 'cover.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByLabelText('Album artwork image'), { target: { files: [file] } })
    await vi.waitFor(() => expect(upload).toHaveBeenCalledWith('album-1', file))
  })

  it('says when the album shows an uploaded image', () => {
    useAlbumArtwork.setState({ overrides: { 'album-1': { albumId: 'album-1', provider: 'upload', url: '/api/album-artwork/image/x', source: 'manual' } } })
    render(<AlbumArtworkPicker album={album}/>)
    expect(screen.getByText('Showing an image uploaded from a device.')).toBeInTheDocument()
  })

  it('names the catalogues searched, the title used and why a catalogue failed', async () => {
    lookup.mockResolvedValue({ candidates: [], query: { album: 'Gold', artist: 'Earth, Wind & Fire' }, searched: ['apple', 'deezer'], failed: [{ provider: 'spotify', message: 'Spotify search returned HTTP 403.' }] })
    render(<AlbumArtworkPicker album={album} searchOnOpen/>)
    expect(await screen.findByText('Apple and Deezer have no confident match for “Gold” by Earth, Wind & Fire.')).toBeInTheDocument()
    expect(screen.getByText('Spotify could not be searched: Spotify search returned HTTP 403.')).toBeInTheDocument()
  })

  it('waits for a click before searching otherwise', () => {
    render(<AlbumArtworkPicker album={album}/>)
    expect(lookup).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Find better artwork/ })).toBeInTheDocument()
  })
})
