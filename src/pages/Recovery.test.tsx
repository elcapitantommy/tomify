import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryApi } from '../lib/recovery-api'
import type { RecoveryItem } from '../lib/recovery'
import { Recovery } from './Recovery'

vi.mock('../lib/recovery-api', () => ({
  recoveryApi: {
    list: vi.fn(), add: vi.fn(), search: vi.fn(), select: vi.fn(), acquire: vi.fn(), importRemaining: vi.fn(), updateStatus: vi.fn(), pollJob: vi.fn(), delete: vi.fn(),
  },
}))

const backends = [
  { id: 'youtube', label: 'YouTube', available: true as const },
  { id: 'internet-archive', label: 'Internet Archive', available: true as const },
  { id: 'usenet', label: 'Usenet / NZB', available: true as const },
]

function item(overrides: Partial<RecoveryItem> = {}): RecoveryItem {
  return {
    id: 'recovery-1', artist: 'Zara Larson', title: 'lush life', status: 'candidate-found', createdAt: '2026-01-01', updatedAt: '2026-01-01', candidates: [], ...overrides,
  }
}

function renderRecovery() {
  return render(<MemoryRouter><Recovery/></MemoryRouter>)
}

describe('Recovery page actions', () => {
  beforeEach(() => { vi.clearAllMocks() })

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
    const fields = screen.getByRole('group', { name: 'Usenet search fields' })
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
    const fields = screen.getByRole('group', { name: 'Usenet search fields' })
    expect(within(fields).getByRole('checkbox', { name: 'Track' })).toBeDisabled()
    const artist = within(fields).getByRole('checkbox', { name: 'Artist' })
    const album = within(fields).getByRole('checkbox', { name: 'Album' })
    expect(artist).toBeChecked()
    expect(album).toBeChecked()

    fireEvent.click(album)
    expect(screen.getByRole('button', { name: 'Search NZB' })).toBeDisabled()
    fireEvent.click(artist)
    fireEvent.click(album)
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'usenet', ['album'])
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
})
