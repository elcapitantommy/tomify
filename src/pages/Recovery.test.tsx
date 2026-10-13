import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryApi } from '../lib/recovery-api'
import type { RecoveryItem } from '../lib/recovery'
import { Recovery } from './Recovery'

vi.mock('../lib/recovery-api', () => ({
  recoveryApi: {
    list: vi.fn(), add: vi.fn(), search: vi.fn(), select: vi.fn(), acquire: vi.fn(), updateStatus: vi.fn(), pollJob: vi.fn(), delete: vi.fn(),
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

  it('searches Newznab independently by artist, track title, or release', async () => {
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({ album: 'Lush Life' })], backends })
    vi.mocked(recoveryApi.search).mockImplementation(() => new Promise(() => {}))
    renderRecovery()
    fireEvent.click(await screen.findByRole('button', { name: /lush life/i }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Usenet search mode' }), { target: { value: 'artist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search NZB' }))
    expect(recoveryApi.search).toHaveBeenCalledWith('recovery-1', 'usenet', 'artist')
  })

  it('continues from metadata and artwork review into source authorisation without resetting choices', async () => {
    const selectedCandidate = { id: 'candidate-1', backend: 'youtube' as const, externalId: 'video-1', url: 'https://www.youtube.com/watch?v=video-1', title: 'Zara Larsson - Lush Life', channel: 'Zara Larsson', official: true, matchScore: 97, selected: true }
    vi.mocked(recoveryApi.list).mockResolvedValue({ items: [item({
      candidates: [selectedCandidate],
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
    expect(artistChoice).not.toBeChecked()
    expect(screen.getByText('No artwork selected')).toBeInTheDocument()
  })
})
