import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completenessApi, type TracklistResponse } from '../lib/completeness-api'
import type { Album, Track } from '../types'
import { AlbumCompleteness } from './AlbumCompleteness'

vi.mock('../lib/completeness-api', () => ({ completenessApi: { tracklist: vi.fn(), addMissing: vi.fn() } }))

const album: Album = { id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', year: 1990 }
const response: TracklistResponse = {
  tracklist: {
    albumId: 'album-1', releaseId: 'release-1', releaseGroupId: 'group-1', title: 'Flood', artist: 'They Might Be Giants', date: '1990-01-15', country: 'US', format: 'CD', status: 'Official', disambiguation: null, discCount: 1, source: 'auto', fetchedAt: '2026-10-15',
    tracks: ['Theme From Flood', 'Birdhouse in Your Soul', 'Lucky Ball and Chain'].map((title, index) => ({ key: `1-${index + 1}`, disc: 1, number: index + 1, title, artist: 'They Might Be Giants', length: 60 + index, recordingId: null })),
  },
  editions: [],
  recovery: { '1-3': { id: 'recovery-3', status: 'needs-upgrade' } },
}
const tracks: Track[] = [{ id: 'track-2', title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 61 }]

function renderCompleteness() {
  return render(<MemoryRouter><AlbumCompleteness album={album} tracks={tracks}/></MemoryRouter>)
}

describe('AlbumCompleteness', () => {
  beforeEach(() => {
    vi.mocked(completenessApi.tracklist).mockReset().mockResolvedValue(response)
    vi.mocked(completenessApi.addMissing).mockReset().mockResolvedValue({ created: 1, existing: 0, recovery: { ...response.recovery, '1-1': { id: 'recovery-1', status: 'missing' } } })
  })

  it('shows progress, the missing tracks and which are already in Recovery', async () => {
    renderCompleteness()
    expect(await screen.findByText('Incomplete · 1 of 3 tracks')).toBeInTheDocument()
    expect(screen.getByText('Theme From Flood')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'In Recovery · Needs upgrade' })).toHaveAttribute('href', '/recovery?item=recovery-3')
    expect(vi.mocked(completenessApi.tracklist).mock.calls[0][0]).toMatchObject({ albumId: 'album-1', localTrackCount: 1 })
  })

  it('adds only the missing tracks that are not already queued', async () => {
    renderCompleteness()
    fireEvent.click(await screen.findByRole('button', { name: 'Add 1 missing to Recovery' }))
    expect(await screen.findByText('1 track added to Recovery.')).toBeInTheDocument()
    expect(completenessApi.addMissing).toHaveBeenCalledWith('album-1', ['1-1'])
    expect(screen.getByRole('button', { name: 'All missing tracks are in Recovery' })).toBeDisabled()
  })

  it('reports a complete album without offering Recovery', async () => {
    vi.mocked(completenessApi.tracklist).mockResolvedValue({ ...response, tracklist: { ...response.tracklist, tracks: response.tracklist.tracks.slice(1, 2) } })
    renderCompleteness()
    expect(await screen.findByText('Complete · 1 of 1 tracks')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /missing to Recovery/ })).not.toBeInTheDocument()
  })

  it('explains when MusicBrainz has no tracklist', async () => {
    vi.mocked(completenessApi.tracklist).mockRejectedValue(Object.assign(new Error('MusicBrainz has no confident tracklist for this album.'), { code: 'tracklist-unavailable' }))
    renderCompleteness()
    expect(await screen.findByText(/Album completeness unavailable/)).toBeInTheDocument()
  })
})
