import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { AlbumArtworkPicker } from './AlbumArtworkPicker'

const album = { id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', year: 1990 }
const candidate = { id: 'apple:1', provider: 'apple' as const, providerLabel: 'Apple', providerId: '1', url: 'https://is1.mzstatic.com/flood.jpg', confidence: 97, album: 'Flood', width: 1200, height: 1200 }

describe('AlbumArtworkPicker', () => {
  const lookup = vi.fn()
  const select = vi.fn()
  beforeEach(() => {
    lookup.mockReset().mockResolvedValue([candidate])
    select.mockReset().mockResolvedValue(undefined)
    useAlbumArtwork.setState({ overrides: {}, status: 'ready', providers: ['apple', 'deezer'], lookup, select })
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

  it('waits for a click before searching otherwise', () => {
    render(<AlbumArtworkPicker album={album}/>)
    expect(lookup).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Find better artwork/ })).toBeInTheDocument()
  })
})
