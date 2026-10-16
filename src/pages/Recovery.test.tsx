import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryApi } from '../lib/recovery-api'
import type { RecoveryItem } from '../lib/recovery'
import { Recovery } from './Recovery'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { NavidromeClient } from '../lib/navidrome'
import type { RecoveryPlayback } from '../lib/recovery'

vi.mock('../lib/recovery-api', () => ({
  recoveryApi: {
    list: vi.fn(), add: vi.fn(), search: vi.fn(), addTorrentLink: vi.fn(), select: vi.fn(), acquire: vi.fn(), importRemaining: vi.fn(), updateStatus: vi.fn(), pollJob: vi.fn(), cancel: vi.fn(), delete: vi.fn(), checkPlayback: vi.fn(), retryPlayback: vi.fn(),
  },
}))

const backends = [
  { id: 'youtube', label: 'YouTube', available: true as const },
  { id: 'internet-archive', label: 'Internet Archive', available: true as const },
  { id: 'usenet', label: 'Usenet / NZB', available: true as const },
  { id: 'torrent', label: 'Torrents', available: true as const, search: true },
]

function item(overrides: Partial<RecoveryItem> = {}): RecoveryItem {
  return {
    id: 'recovery-1', artist: 'Zara Larson', title: 'lush life', status: 'candidate-found', createdAt: '2026-01-01', updatedAt: '2026-01-01', candidates: [], ...overrides,
  }
}

function renderRecovery() {
  return render(<MemoryRouter><Recovery/></MemoryRouter>)
}

describe('Recovery page access', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('tells non-administrators Recovery is admin-only and never loads the queue', () => {
    useAuth.setState({ isAdmin: false })
    renderRecovery()
    expect(screen.getByText('Recovery is only available to Navidrome administrators.')).toBeInTheDocument()
    expect(recoveryApi.list).not.toHaveBeenCalled()
  })

  it('waits for the role check before loading the queue', () => {
    useAuth.setState({ isAdmin: null })
    renderRecovery()
    expect(screen.getByText('Checking your account…')).toBeInTheDocument()
    expect(recoveryApi.list).not.toHaveBeenCalled()
  })
})

describe('Recovery page actions', () => {
  beforeEach(() => { vi.clearAllMocks(); useAuth.setState({ isAdmin: true }) })

  it('waits for the current job-poll round to settle before scheduling another', async () => {
    vi.useFakeTimers()
    try {
      let finishPoll!: (value: { item: RecoveryItem }) => void
      const pendingPoll = new Promise<{ item: RecoveryItem }>((resolve) => { finishPoll = resolve })
      const active = item({ status: 'downloading' })
      vi.mocked(recoveryApi.list).mockResolvedValue({ items: [active], backends })
      vi.mocked(recoveryApi.pollJob).mockReturnValue(pendingPoll)
      renderRecovery()
      await act(async () => { await Promise.resolve(); await Promise.resolve() })

      act(() => { vi.advanceTimersByTime(3000) })
      expect(recoveryApi.pollJob).toHaveBeenCalledTimes(1)
      act(() => { vi.advanceTimersByTime(6000) })
      expect(recoveryApi.pollJob).toHaveBeenCalledTimes(1)

      await act(async () => { finishPoll({ item: active }); await pendingPoll })
      act(() => { vi.advanceTimersByTime(2999) })
      expect(recoveryApi.pollJob).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })
      expect(recoveryApi.pollJob).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['Search YouTube', 'Search Internet Archive'],
    ['Search Internet Archive', 'Search YouTube'],
  ])('shows a spinner only on the running %s action', async (activeLabel, inactiveLabel) => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends })
    vi.mocked(recoveryApi.search).mockImplementation(() => new Promise(() => {}))
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))

    const active = screen.getByRole('button', { name: activeLabel })
    const inactive = screen.getByRole('button', { name: inactiveLabel })
    fireEvent.click(active)

    expect(active).toBeDisabled()
    expect(inactive).toBeDisabled()
    expect(active.querySelector('.spin')).not.toBeNull()
    expect(inactive.querySelector('.spin')).toBeNull()
  })

  it('searches Usenet with any combination of artist, album and track', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ album: 'Lush Life' })], backends })
    vi.mocked(recoveryApi.search).mockImplementation(() => new Promise(() => {}))
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    const fields = screen.getByRole('group', { name: 'NZB and torrent search fields' })
    const artist = within(fields).getByRole('checkbox', { name: 'Artist' })
    const album = within(fields).getByRole('checkbox', { name: 'Album' })
    const track = within(fields).getByRole('checkbox', { name: 'Track' })
    expect([artist, album, track].map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true])

    fireEvent.click(album)
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'usenet', ['artist', 'album', 'track'])
  })

  it('defaults to an artist and album search for a whole-album wanted item and blocks empty searches', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ title: '', artist: 'They Might Be Giants', album: 'Flood' })], backends })
    vi.mocked(recoveryApi.search).mockImplementation(() => new Promise(() => {}))
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /flood/i }))
    const fields = screen.getByRole('group', { name: 'NZB and torrent search fields' })
    expect(within(fields).getByRole('checkbox', { name: 'Track' })).toBeDisabled()
    const artist = within(fields).getByRole('checkbox', { name: 'Artist' })
    const album = within(fields).getByRole('checkbox', { name: 'Album' })
    expect(artist).toBeChecked()
    expect(album).toBeChecked()

    fireEvent.click(album)
    expect(screen.getByRole('button', { name: 'Search NZB' })).toBeEnabled()
    fireEvent.click(artist)
    expect(screen.getByRole('button', { name: 'Search NZB' })).toBeDisabled()
    fireEvent.click(album)
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'usenet', ['album'])
    expect(screen.getByRole('status')).toHaveTextContent('Searching NZB indexers…')
  })

  it('allows an artist-only NZB search for wanted music by an artist and reports the outcome on the row', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ title: '', artist: 'They Might Be Giants', album: '' })], backends })
    vi.mocked(recoveryApi.search).mockRejectedValueOnce(new Error('NZBIndex search failed.')).mockResolvedValueOnce({ item: item({ title: '', artist: 'They Might Be Giants', album: '' }) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /they might be giants/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'usenet', ['artist'])
    expect(await screen.findByText('NZBIndex search failed.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(await screen.findByText('NZB search found no results.')).toBeInTheDocument()
  })

  it('adds wanted music from any one of artist, album or track', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [], backends })
    vi.mocked(recoveryApi.add).mockResolvedValue({ item: item({ id: 'recovery-2', title: '', artist: '', album: 'Flood' }) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: 'Add wanted music' }))
    const submit = screen.getByRole('button', { name: 'Add to queue' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Album' }), { target: { value: ' Flood ' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(recoveryApi.add).toHaveBeenCalledWith({ artist: undefined, title: undefined, album: 'Flood', duration: undefined, trackNumber: undefined })
    expect(await screen.findByText('Whole album')).toBeInTheDocument()
  })

  it('offers to import the rest of a single-track Usenet download once', async () => {
    const imported = { id: 'candidate-1', backend: 'usenet' as const, externalId: 'flood', url: 'https://www.nzbindex.com/collection/flood', title: '[1/6] "They Might Be Giants - Flood.zip" - yEnc', channel: 'NZBIndex', official: false, matchScore: 37, selected: true, importedPath: '/recovery/Birdhouse in Your Soul.mp3', provenance: { searchMode: 'track' as const, importedCount: 1, job: { id: 'job-1', status: 'completed' as const, progress: 100 } } }
    const completed = { ...imported, provenance: { ...imported.provenance, importedCount: 3, remainingImportedAt: '2026-10-15T00:00:00.000Z' } }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', status: 'needs-upgrade', candidates: [imported] })], backends })
    vi.mocked(recoveryApi.importRemaining).mockResolvedValue({ item: item({ title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', status: 'needs-upgrade', candidates: [completed] }) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /birdhouse/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Import rest of download' }))
    expect(recoveryApi.importRemaining).toHaveBeenCalledWith('recovery-1')
    expect((await screen.findAllByText('Imported 3 tracks')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Import rest of download' })).toBeNull()
  })

  it('shows the delete confirmation directly under the action buttons, above the candidates', async () => {
    const candidate = { id: 'candidate-1', backend: 'usenet' as const, externalId: 'x', url: 'https://www.nzbindex.com/collection/x', title: 'Candidate', channel: 'NZBIndex', official: false, matchScore: 37, selected: false }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ candidates: [candidate] })], backends })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const prompt = screen.getByText('Delete this recovery item?').closest('.delete-confirm')
    expect(prompt?.previousElementSibling).toHaveClass('recovery-actions')
    expect(prompt?.nextElementSibling).toHaveClass('candidate-list')
  })

  it('disables deletion while an item is importing', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ status: 'importing' })], backends })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it.each(['queued', 'downloading', 'importing'] as const)('confirms before cancelling a %s job and keeps the candidate', async (status) => {
    const candidate = { id: 'candidate-1', backend: 'usenet' as const, externalId: 'x', url: 'https://www.nzbindex.com/collection/x', title: 'Candidate', channel: 'NZBIndex', official: false, matchScore: 80, selected: true, provenance: { job: { id: 'job-1', status, progress: status === 'queued' ? 0 : 50 } } }
    const active = item({ status, candidates: [candidate] })
    const cancelled = item({ status: 'candidate-found', candidates: [{ ...candidate, provenance: {} }] })
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [active], backends })
    vi.mocked(recoveryApi.pollJob).mockImplementation(() => new Promise(() => {}))
    vi.mocked(recoveryApi.cancel).mockResolvedValue({ item: cancelled })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Cancel this recovery job?')).toBeInTheDocument()
    expect(recoveryApi.cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }))

    expect(recoveryApi.cancel).toHaveBeenCalledWith('recovery-1')
    expect(await screen.findByText('Review candidate')).toBeInTheDocument()
    expect(screen.getByText('Candidate')).toBeInTheDocument()
  })

  it('continues from metadata and artwork review into source authorisation without resetting choices', async () => {
    const selectedCandidate = { id: 'candidate-1', backend: 'youtube' as const, externalId: 'video-1', url: 'https://www.youtube.com/watch?v=video-1', title: 'Zara Larsson - Lush Life', channel: 'Zara Larsson', official: true, matchScore: 97, selected: true }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({
      candidates: [selectedCandidate, { ...selectedCandidate, id: 'candidate-2', externalId: 'video-2', url: 'https://www.youtube.com/watch?v=video-2', title: 'Other upload', matchScore: 40, selected: false }],
      metadataResolution: { authority: 'musicbrainz', status: 'matched', confidence: 97, strong: true, candidateId: 'candidate-1', resolvedAt: '2026-01-01', metadata: { artist: 'Zara Larsson', title: 'Lush Life', album: '1', releaseDate: '2014-06-09', trackNumber: 1 } },
      artworkResolution: { candidateId: 'candidate-1', resolvedAt: '2026-01-01', selectedCandidateId: 'apple:1', candidates: [{ id: 'apple:1', provider: 'apple', providerLabel: 'Apple catalogue', providerId: '1', url: 'https://example.test/cover.jpg', previewUrl: 'https://example.test/cover.jpg', confidence: 95, quality: 'high', square: true, selectable: true }] },
    })], backends })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))

    const artistChoice = screen.getByRole('checkbox', { name: /Use matched artist/i })
    fireEvent.click(artistChoice)
    fireEvent.click(screen.getByRole('button', { name: 'No artwork' }))
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to import' }))

    expect(screen.getByText('Confirm this source can be copied')).toBeInTheDocument()
    // Both panels open directly under the selected candidate, before the next one.
    const selectedRow = screen.getByText('Zara Larsson - Lush Life').closest('.candidate')!
    const nextRow = screen.getByText('Other upload').closest('.candidate')!
    for (const panel of [artistChoice, screen.getByText('Confirm this source can be copied')]) {
      expect(selectedRow.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(panel.compareDocumentPosition(nextRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(artistChoice).not.toBeChecked()
    expect(screen.getByText('No artwork selected')).toBeInTheDocument()
  })

  it('shows the imported track count for a completed Usenet release', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({
      status: 'needs-upgrade', album: 'Flood', candidates: [{ id: 'candidate-1', backend: 'usenet', externalId: 'release-1', url: 'https://www.nzbindex.com/collection/release-1', title: 'They Might Be Giants - Flood', channel: 'NZBIndex', official: false, matchScore: 90, selected: true, importedPath: '/srv/music-recovery/They Might Be Giants/Flood/01 - Theme from Flood.mp3', provenance: { importedCount: 19, importedTracks: [] } }],
    })], backends })
    renderRecovery()
    expect(await screen.findByText('Imported 19 tracks')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /lush life/i }))
    expect(screen.getAllByText('Imported 19 tracks').length).toBeGreaterThan(1)
  })

  it('searches torrents with the chosen fields and shows seeds, peers and size on each result', async () => {
    const result = { id: 'torrent-2', backend: 'torrent' as const, externalId: 's', url: 'https://thepiratebay.org/description.php?id=1', title: 'Zara Larsson - Lush Life FLAC', channel: 'thepiratebay.org', official: false, matchScore: 80, selected: false, provenance: { raw: { providerId: 'qbittorrent-search', seeds: 42, peers: 3, size: 512_000_000 } } }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends })
    vi.mocked(recoveryApi.search).mockResolvedValue({ item: item({ candidates: [result] }) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Search torrents' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'torrent', ['artist', 'track'])
    expect(await screen.findByText('Torrent search found 1 result.')).toBeInTheDocument()
    expect(screen.getByText(/42 seeds · 3 peers · 512 MB/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open candidate on the torrent site' })).toHaveAttribute('href', result.url)
  })

  it('keeps torrent search off when the recovery agent only accepts pasted links', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends: backends.map((backend) => backend.id === 'torrent' ? { ...backend, search: false } : backend) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    expect(screen.getByRole('button', { name: 'Search torrents' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Torrent link' })).toBeEnabled()
  })

  it('adds a pasted torrent link and selects it for review straight away', async () => {
    const link = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Flood'
    const torrent = { id: 'torrent-1', backend: 'torrent' as const, externalId: 't', url: link, title: 'Flood', channel: 'Torrent link', official: false, matchScore: 60, selected: false }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends })
    vi.mocked(recoveryApi.addTorrentLink).mockResolvedValue({ item: item({ candidates: [torrent] }) })
    vi.mocked(recoveryApi.select).mockResolvedValue({ item: item({ candidates: [{ ...torrent, selected: true }] }) })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    const input = screen.getByRole('textbox', { name: 'Torrent link' })
    expect(input).toHaveAttribute('placeholder', 'Paste a magnet or .torrent link')
    const add = screen.getByRole('button', { name: 'Add link' })
    fireEvent.change(input, { target: { value: 'not a link' } })
    expect(add).toBeDisabled()
    fireEvent.change(input, { target: { value: link } })
    fireEvent.click(add)
    expect(recoveryApi.addTorrentLink).toHaveBeenCalledWith('recovery-1', link)
    await vi.waitFor(() => expect(recoveryApi.select).toHaveBeenCalledWith('recovery-1', 'torrent-1'))
    expect(await screen.findByText(/Pasted torrent link/)).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('reports a rejected torrent link on the row', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends })
    vi.mocked(recoveryApi.addTorrentLink).mockRejectedValue(new Error('The magnet link has an invalid info hash.'))
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Torrent link' }), { target: { value: 'magnet:?xt=urn:btih:bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }))
    expect(await screen.findByText('The magnet link has an invalid info hash.')).toBeInTheDocument()
    expect(recoveryApi.select).not.toHaveBeenCalled()
  })

  it('shows live torrent speed, seeds and ETA and still allows deleting a running torrent', async () => {
    const running = { id: 'torrent-1', backend: 'torrent' as const, externalId: 't', url: 'magnet:?xt=urn:btih:abc', title: 'Flood', channel: 'Torrent link', official: false, matchScore: 60, selected: true, provenance: { job: { id: 'job-1', status: 'downloading' as const, progress: 37, details: { downloadSpeed: 2_400_000, seeds: 12, seedsInSwarm: 40, peers: 3, size: 1_100_000_000, downloaded: 412_000_000, eta: 245 } } } }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ status: 'downloading', candidates: [running] })], backends })
    vi.mocked(recoveryApi.pollJob).mockImplementation(() => new Promise(() => {}))
    vi.mocked(recoveryApi.delete).mockResolvedValue({ deleted: true, filesRemoved: false })
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    expect(screen.getByText('2.4 MB/s · 12 seeds (40) · 3 peers · 412 MB of 1.1 GB · 4 min left')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search YouTube' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(/stops the torrent and removes it and everything it has downloaded from qBittorrent/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(recoveryApi.delete).toHaveBeenCalledWith('recovery-1')
  })
})

describe('Recovery library scan states', () => {
  const imported = { id: 'candidate-1', backend: 'usenet' as const, externalId: 'flood', url: 'https://indexer.test/flood', title: 'Flood', channel: 'Indexer', official: false, matchScore: 80, selected: true, importedPath: '/recovery/Flood/01 - Birdhouse in Your Soul.flac' }
  const importedItem = (playback: RecoveryPlayback) => item({ title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', status: 'recovered', candidates: [imported], playback })
  const since = '2026-10-16T12:00:00.000Z'
  beforeEach(() => { vi.clearAllMocks(); useAuth.setState({ isAdmin: true, session: { serverUrl: 'https://music.test', username: 'tom', token: 't', salt: 's' } }) })

  it('shows a pending import as waiting for the library scan and checks the library on load', async () => {
    const pending = importedItem({ state: 'scan-pending', since })
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [pending], backends })
    vi.mocked(recoveryApi.checkPlayback).mockResolvedValue({ item: pending })
    renderRecovery()
    expect(await screen.findByText('Imported, waiting for library scan')).toBeInTheDocument()
    expect(screen.getByText('Recovered', { selector: '.recovery-status' })).toBeInTheDocument()
    expect(recoveryApi.checkPlayback).toHaveBeenCalledWith('recovery-1')
  })

  it('switches to ready to play when the check finds the track, and plays the Navidrome song', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [importedItem({ state: 'scan-pending', since })], backends })
    vi.mocked(recoveryApi.checkPlayback).mockResolvedValue({ item: importedItem({ state: 'ready', since, songId: 'song-9' }) })
    const song = vi.spyOn(NavidromeClient.prototype, 'song').mockResolvedValue({ id: 'song-9', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood' })
    renderRecovery()
    expect(await screen.findByText('Ready to play')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play Birdhouse in Your Soul' }))
    await vi.waitFor(() => expect(usePlayer.getState().queue[0]?.id).toBe('song-9'))
    expect(song).toHaveBeenCalledWith('song-9')
    song.mockRestore()
  })

  it('shows a failed scan as not found with a retry that waits for the scan again', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [importedItem({ state: 'scan-failed', since })], backends })
    vi.mocked(recoveryApi.retryPlayback).mockResolvedValue({ item: importedItem({ state: 'scan-pending', since: '2026-10-16T12:10:00.000Z' }) })
    vi.mocked(recoveryApi.checkPlayback).mockResolvedValue({ item: importedItem({ state: 'scan-pending', since: '2026-10-16T12:10:00.000Z' }) })
    renderRecovery()
    expect(await screen.findByText('Not found in library after scan')).toBeInTheDocument()
    expect(recoveryApi.checkPlayback).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan' }))
    expect(recoveryApi.retryPlayback).toHaveBeenCalledWith('recovery-1')
    expect(await screen.findByText('Imported, waiting for library scan')).toBeInTheDocument()
  })

  it('shows no scan state for an item that was never imported', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item()], backends })
    renderRecovery()
    await screen.findByText('lush life')
    expect(screen.queryByText(/library scan|Ready to play|Not found in library/)).toBeNull()
  })
})
