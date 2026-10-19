import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByText(/Files only move when you confirm a merge or promotion/)).toBeInTheDocument()
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

  it('marks a finding as fine and can report it again', async () => {
    const entry = { kind: 'recording', label: 'Rammstein — Rammstein', paths: ['/master/Rammstein/3-04.flac', '/master/Rammstein/4-04.flac'] }
    let dismissed = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/dismiss')) { dismissed = !JSON.parse(String(init?.body)).restore; return Response.json({ ok: true }) }
      if (path.endsWith('/report')) return Response.json({ report: dismissed ? { ...emptyReport, dismissed: [{ ...entry, category: 'duplicates' }] } : { ...emptyReport, duplicates: [entry] } })
      return Response.json({ status: idleStatus })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as fine: Rammstein — Rammstein' }))
    expect(await screen.findByText('Marked as fine')).toBeInTheDocument()
    expect(screen.getByText('No duplicate recordings or similar directory names found.')).toBeInTheDocument()
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/dismiss'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ category: 'duplicates', paths: entry.paths, label: entry.label, restore: false })
    fireEvent.click(screen.getByRole('button', { name: 'Report again: Rammstein — Rammstein' }))
    expect(await screen.findByRole('button', { name: 'Mark as fine: Rammstein — Rammstein' })).toBeInTheDocument()
    // The page updates from the change itself and never waits on a slow report recompute.
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/report'))).toHaveLength(1)
  })

  it('updates straight away even when the report is slow to recompute', async () => {
    const entry = { kind: 'partial-album', label: 'The Beach Boys — Surfin USA', paths: ['/recovery/Beach Boys/Surfin USA/13.flac'] }
    let reports = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/dismiss')) return Response.json({ ok: true })
      if (path.endsWith('/report')) { reports += 1; if (reports > 1) return new Promise<Response>(() => {}); return Response.json({ report: { ...emptyReport, partialAlbums: [entry] } }) }
      return Response.json({ status: idleStatus })
    }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as fine: The Beach Boys — Surfin USA' }))
    expect(await screen.findByRole('button', { name: 'Report again: The Beach Boys — Surfin USA' })).not.toBeDisabled()
    expect(screen.getByText('No track-number gaps or incomplete cached editions found.')).toBeInTheDocument()
  })

  it('explains that an older recovery agent needs redeploying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'inventory-not-available', message: 'Unavailable' }, { status: 404 })))
    renderPage()
    expect(await screen.findByText('Recovery agent update needed')).toBeInTheDocument()
    expect(screen.getByText(/Redeploy the recovery agent/)).toBeInTheDocument()
  })

  it('plans a merge, applies the chosen copy and relinks the administrator\'s playlists', async () => {
    const entry = { kind: 'recording', label: 'The Kinks — Waterloo Sunset', paths: ['/master/Kinks/a.flac', '/master/Kinks (2)/a.flac'] }
    const plans: unknown[] = []
    let applied: Record<string, unknown> | null = null
    let replaced: string | null = null
    const journal = { id: '6f1c1f9e-4d1a-4c84-9a8e-111111111111', createdAt: '2026-10-19T10:00:00.000Z', kind: 'merge', label: entry.label, moves: [{ from: '/master/Kinks/a.flac', to: '/master/_Duplicates/Kinks/a.flac' }], status: 'applied' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://app.test')
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      const subsonic = (data: object) => Response.json({ 'subsonic-response': { status: 'ok', ...data } })
      if (url.pathname.endsWith('/report')) return Response.json({ report: { ...emptyReport, duplicates: [entry] } })
      if (url.pathname.endsWith('/library-moves/list')) return Response.json({ moves: applied ? [journal] : [] })
      if (url.pathname.endsWith('/library-moves/plan')) {
        plans.push(body)
        const moved = body.paths.find((path: string) => path !== body.keep)
        return Response.json({ kind: 'merge', label: entry.label, moves: [{ from: moved, to: `/master/_Duplicates${moved.slice(7)}` }], conflicts: [], sizes: { '/master/Kinks/a.flac': 100, '/master/Kinks (2)/a.flac': 200 } })
      }
      if (url.pathname.endsWith('/library-moves/apply')) { applied = body; return Response.json({ journal, relinked: 1 }) }
      if (url.pathname.endsWith('/search3.view')) return subsonic({ searchResult3: { song: [{ id: 'song-a', title: 'Waterloo Sunset', size: 100, suffix: 'flac' }, { id: 'song-b', title: 'Waterloo Sunset', size: 200, suffix: 'flac' }] } })
      if (url.pathname.endsWith('/getPlaylists.view')) return subsonic({ playlists: { playlist: [{ id: 'pl-1', name: 'Sixties', owner: 'tom' }] } })
      if (url.pathname.endsWith('/getPlaylist.view')) return subsonic({ playlist: { id: 'pl-1', name: 'Sixties', owner: 'tom', entry: [{ id: 'song-x' }, { id: 'song-a' }] } })
      if (url.pathname.endsWith('/createPlaylist.view')) { replaced = String(init?.body); return subsonic({}) }
      if (url.pathname.endsWith('/startScan.view')) return subsonic({ scanStatus: { scanning: true } })
      return Response.json({ status: idleStatus })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Merge…: The Kinks — Waterloo Sunset' }))
    expect(await screen.findByText('/master/_Duplicates/Kinks (2)/a.flac')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '/master/Kinks (2)/a.flac' }))
    expect(await screen.findByText('/master/_Duplicates/Kinks/a.flac')).toBeInTheDocument()
    expect(plans.at(-1)).toEqual({ kind: 'merge', keep: '/master/Kinks (2)/a.flac', paths: entry.paths, label: entry.label })
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Moved 1 item. Pointed 1 song at the kept copy in imported playlists and 1 of your Navidrome playlists.')
    expect(applied).toEqual({ kind: 'merge', keep: '/master/Kinks (2)/a.flac', paths: entry.paths, label: entry.label, relink: { 'song-a': 'song-b' } })
    expect(new URLSearchParams(replaced ?? '').getAll('songId')).toEqual(['song-x', 'song-b'])
    expect(screen.getByText('No duplicate recordings or similar directory names found.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Undo: The Kinks — Waterloo Sunset' })).toBeInTheDocument()
  })

  it('promotes a Recovery copy, refuses a plan with conflicts, and undoes a recent move', async () => {
    const entry = { kind: 'shadowed-recovery', label: 'ELO — Mr. Blue Sky', paths: ['/master/ELO/05.mp3', '/recovery/ELO/05.flac'], masterPaths: ['/master/ELO/05.mp3'], recoveryPaths: ['/recovery/ELO/05.flac'] }
    const journal = { id: '6f1c1f9e-4d1a-4c84-9a8e-222222222222', createdAt: '2026-10-19T10:00:00.000Z', kind: 'merge', label: 'Rammstein — Rammstein', moves: [{ from: '/master/R/a.flac', to: '/master/_Duplicates/R/a.flac' }], status: 'applied' }
    let undone: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/report')) return Response.json({ report: { ...emptyReport, shadowedRecovery: [entry] } })
      if (path.endsWith('/library-moves/list')) return Response.json({ moves: [undone ? { ...journal, status: 'undone' } : journal] })
      if (path.endsWith('/library-moves/plan')) return Response.json({ kind: 'promote', label: entry.label, moves: [{ from: '/master/ELO/05.mp3', to: '/master/_Duplicates/ELO/05.mp3' }, { from: '/recovery/ELO/05.flac', to: '/master/ELO/05.flac' }], conflicts: ['/master/ELO/05.flac'], sizes: {} })
      if (path.endsWith('/library-moves/undo')) { undone = JSON.parse(String(init?.body)); return Response.json({ journal: { ...journal, status: 'undone' } }) }
      if (path.includes('/rest/')) return Response.json({ 'subsonic-response': { status: 'ok' } })
      return Response.json({ status: idleStatus })
    }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Promote…: ELO — Mr. Blue Sky' }))
    expect(await screen.findByText(/Something already exists at \/master\/ELO\/05.flac/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Rammstein — Rammstein' }))
    expect(await screen.findByText(/Moved everything back/)).toBeInTheDocument()
    expect(undone).toEqual({ id: journal.id })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo: Rammstein — Rammstein' })).not.toBeInTheDocument())
  })

  it('hides merging and promotion when the recovery agent has no library moves', async () => {
    const entry = { kind: 'recording', label: 'NOFX — Lower', paths: ['/master/a.mp3', '/master/b.mp3'] }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/report')) return Response.json({ report: { ...emptyReport, duplicates: [entry] } })
      if (path.includes('/library-moves/')) return Response.json({ error: 'library-moves-not-available' }, { status: 404 })
      return Response.json({ status: idleStatus })
    }))
    renderPage()
    expect(await screen.findByText('NOFX — Lower')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Merge…/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Recent moves')).not.toBeInTheDocument()
  })
})
