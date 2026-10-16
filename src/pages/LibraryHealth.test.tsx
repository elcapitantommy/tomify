import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { LibraryHealth } from './LibraryHealth'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 'salt', token: 'token' }
const emptyReport = { completedAt: '2026-10-16T12:00:00.000Z', duplicates: [], partialAlbums: [], orphanedSources: [], shadowedRecovery: [], missingD1Files: [] }
const idleStatus = { state: 'completed', progress: 100, filesDiscovered: 20, filesProcessed: 20, currentPath: null, lastCompletedAt: emptyReport.completedAt, error: null }

function renderPage() { return render(<MemoryRouter><LibraryHealth/></MemoryRouter>) }

describe('Library health', () => {
  beforeEach(() => { useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: true }) })

  it('shows a loading state while the stored report is fetched', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderPage()
    expect(screen.getByText('Checking the inventory…')).toBeInTheDocument()
  })

  it('shows all empty read-only categories', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/report') ? Response.json({ report: emptyReport }) : Response.json({ status: idleStatus })))
    renderPage()
    expect(await screen.findByText('No duplicate recordings or similar directory names found.')).toBeInTheDocument()
    expect(screen.getByText('Every imported Recovery record points to an inventoried file.')).toBeInTheDocument()
    expect(screen.getByText(/Nothing here deletes, moves or merges files/)).toBeInTheDocument()
  })

  it('renders populated categories with album and Recovery links and starts a scan', async () => {
    const report = { ...emptyReport,
      duplicates: [{ kind: 'recording', label: 'The Kinks — Waterloo Sunset', paths: ['/master/Kinks/a.flac', '/recovery/Kinks/a.flac'], recoveryId: 'recovery-1' }],
      partialAlbums: [{ kind: 'partial-album', label: 'They Might Be Giants — Flood', paths: ['/master/TMBG/Flood/01.flac'], albumId: 'album-1', actualTracks: 18, expectedTracks: 19 }],
      missingD1Files: [{ kind: 'missing-d1-file', label: 'Missing Recovery track', paths: ['/recovery/missing.flac'], recoveryId: 'recovery-2' }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/report')) return Response.json({ report })
      if (path.endsWith('/scan')) return Response.json({ started: true, status: { ...idleStatus, state: 'running', progress: 25, filesProcessed: 5 } }, { status: 202 })
      return Response.json({ status: idleStatus })
    }))
    renderPage()
    expect(await screen.findByText('The Kinks — Waterloo Sunset')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open They Might Be Giants — Flood' })).toHaveAttribute('href', '/albums/album-1')
    expect(screen.getByRole('link', { name: 'Open Missing Recovery track' })).toHaveAttribute('href', '/recovery?item=recovery-2')
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }))
    expect(await screen.findByRole('button', { name: 'Scanning 25%' })).toBeDisabled()
  })

  it('explains that an older recovery agent needs redeploying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'inventory-not-available', message: 'Unavailable' }, { status: 404 })))
    renderPage()
    expect(await screen.findByText('Recovery agent update needed')).toBeInTheDocument()
    expect(screen.getByText(/Redeploy the recovery agent/)).toBeInTheDocument()
  })
})
