import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Album } from '../types'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { ArtistDetail } from './ArtistDetail'

const release = (id: string, name: string, releaseType: 'album' | 'compilation' | 'single'): Album => ({ id, name, artist: 'Test Artist', year: 2000, releaseTypes: [releaseType] })
let releases: Album[] = []
const api = { session: { username: 'guest' }, artist: vi.fn(async (id: string) => ({ artist: { id, name: `Artist ${id}`, album: releases } })), album: vi.fn(), coverArtUrl: () => 'https://music.example/cover.jpg' }

vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../components/ArtistAbout', () => ({ ArtistPopular: () => null, ArtistAbout: () => null }))
vi.mock('../components/MediaCards', () => ({ AlbumCard: ({ displayTitle }: { displayTitle: string }) => <p>{displayTitle}</p> }))
vi.mock('../components/Artwork', () => ({ Artwork: () => null }))

let artistCount = 0
function LocationProbe() { return <output data-testid="search">{useLocation().search}</output> }
function renderArtist(search = '') {
  artistCount += 1
  return render(<MemoryRouter initialEntries={[`/artists/a${artistCount}${search}`]}><Routes><Route path="/artists/:id" element={<><ArtistDetail/><LocationProbe/></>}/></Routes></MemoryRouter>)
}
const activeTab = () => document.querySelector('.release-tab.active')?.firstChild?.textContent

describe('ArtistDetail default release tab', () => {
  beforeEach(() => useReleaseMetadata.setState({ overrides: {}, cloudStatus: 'local' } as never))

  it('opens on Albums when the artist has albums', async () => {
    releases = [release('1', 'Studio LP', 'album'), release('2', 'Greatest Hits', 'compilation')]
    renderArtist()
    expect(await screen.findByText('Studio LP')).toBeInTheDocument()
    expect(activeTab()).toBe('Albums')
  })

  it('opens on Compilations when there are no albums', async () => {
    releases = [release('2', 'Greatest Hits', 'compilation'), release('3', 'Hit Single', 'single')]
    renderArtist()
    expect(await screen.findByText('Greatest Hits')).toBeInTheDocument()
    expect(screen.queryByText('Hit Single')).not.toBeInTheDocument()
    expect(activeTab()).toBe('Compilations')
    // Picking the empty Albums tab still works, and is kept in the URL.
    fireEvent.click(screen.getByRole('button', { name: /^Albums/ }))
    expect(activeTab()).toBe('Albums')
    expect(screen.getByTestId('search').textContent).toBe('?type=album')
  })

  it('opens on Singles & EPs when there are no albums or compilations', async () => {
    releases = [release('3', 'Hit Single', 'single')]
    renderArtist()
    expect(await screen.findByText('Hit Single')).toBeInTheDocument()
    expect(activeTab()).toBe('Singles & EPs')
  })

  it('keeps a tab chosen in the URL', async () => {
    releases = [release('2', 'Greatest Hits', 'compilation'), release('3', 'Hit Single', 'single')]
    renderArtist('?type=single-ep')
    expect(await screen.findByText('Hit Single')).toBeInTheDocument()
    expect(activeTab()).toBe('Singles & EPs')
  })
})
