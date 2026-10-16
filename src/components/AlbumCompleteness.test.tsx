import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completenessApi, type TracklistResponse } from '../lib/completeness-api'
import type { Album, Track } from '../types'
import { AlbumCompleteness } from './AlbumCompleteness'
import { useAuth } from '../stores/auth'

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
  const view = render(<MemoryRouter><AlbumCompleteness album={album} tracks={tracks}/></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: 'Check completeness' }))
  return view
}

describe('AlbumCompleteness', () => {
  beforeEach(() => {
    useAuth.setState({ isAdmin: true })
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

  it('does not ask MusicBrainz until the check is run', async () => {
    render(<MemoryRouter><AlbumCompleteness album={album} tracks={tracks}/></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Check completeness' })).toBeInTheDocument()
    expect(completenessApi.tracklist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check completeness' }))
    expect(await screen.findByText('Incomplete · 1 of 3 tracks')).toBeInTheDocument()
    expect(completenessApi.tracklist).toHaveBeenCalledTimes(1)
  })

  it('shows nothing to non-administrators and never runs the check', () => {
    useAuth.setState({ isAdmin: false })
    const { container } = render(<MemoryRouter><AlbumCompleteness album={album} tracks={tracks}/></MemoryRouter>)
    expect(container).toBeEmptyDOMElement()
    expect(completenessApi.tracklist).not.toHaveBeenCalled()
  })

  it('reports a complete album without offering Recovery', async () => {
    vi.mocked(completenessApi.tracklist).mockResolvedValue({ ...response, tracklist: { ...response.tracklist, tracks: response.tracklist.tracks.slice(1, 2) } })
    renderCompleteness()
    expect(await screen.findByText('Complete · 1 of 1 tracks')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /missing to Recovery/ })).not.toBeInTheDocument()
  })

  it('does not call an album complete when it was compared with a much smaller same-titled release', async () => {
    const titles = ['Your Time Has Come', 'Out Of Exile', 'Be Yourself', 'Doesnt Remind Me', 'Drown Me Slowly']
    const local: Track[] = titles.map((title, index) => ({ id: `t${index}`, title, artist: 'Audioslave', album: 'Out Of Exile', track: index + 1 }))
    vi.mocked(completenessApi.tracklist).mockResolvedValue({ ...response, tracklist: { ...response.tracklist, title: 'Out of Exile', format: 'CD-R', tracks: [{ key: '1-1', disc: 1, number: 1, title: 'Out of Exile', artist: 'Audioslave', length: null, recordingId: null }] } })
    render(<MemoryRouter><AlbumCompleteness album={{ ...album, name: 'Out Of Exile', artist: 'Audioslave' }} tracks={local}/></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Check completeness' }))
    expect(await screen.findByText('Edition does not match · 1 of 1 tracks')).toBeInTheDocument()
    expect(screen.getByText(/probably a different release with the same title/)).toBeInTheDocument()
  })

  it('explains when MusicBrainz has no tracklist', async () => {
    vi.mocked(completenessApi.tracklist).mockRejectedValue(Object.assign(new Error('MusicBrainz has no confident tracklist for this album.'), { code: 'tracklist-unavailable' }))
    renderCompleteness()
    expect(await screen.findByText(/Album completeness unavailable/)).toBeInTheDocument()
  })
})
