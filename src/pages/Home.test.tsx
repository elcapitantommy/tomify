import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { Home, MadeForYou } from './Home'

vi.mock('../components/DjPanel', () => ({ DjButton: () => null, DjPanel: () => null }))

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const track = (id: string) => ({ id, title: `Song ${id}`, artist: 'Muse', album: 'Absolution', albumId: 'al1', coverArt: 'al1' })
const mixes = [{ id: 'mix-1', title: 'Saturday morning', description: 'Easy does it.', kind: 'claude', tracks: [track('1'), track('2')], coverArt: ['al1'] }]
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status })
const renderMixes = () => render(<ApiProvider><MemoryRouter><MadeForYou/></MemoryRouter></ApiProvider>)

describe('Made for you', () => {
  beforeEach(() => { useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: null }) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows stored mixes without rebuilding them while they are fresh', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ mixes, generatedAt: 1, curatedBy: 'claude', refreshing: false, stale: false, aiEnabled: true, lastError: null }))
    vi.stubGlobal('fetch', fetcher)
    renderMixes()
    expect(await screen.findByText('Saturday morning')).toBeInTheDocument()
    expect(screen.getByText('Picked by Claude')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Saturday morning/ })).toHaveAttribute('href', '/mixes/mix-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('builds new mixes when the stored ones are a day old', async () => {
    let finish: (value: Response) => void = () => {}
    const built = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/refresh')
      ? built
      : reply({ mixes: [], generatedAt: null, curatedBy: null, refreshing: false, stale: true, aiEnabled: false, lastError: null }))
    vi.stubGlobal('fetch', fetcher)
    renderMixes()
    expect(await screen.findByRole('status')).toHaveTextContent(/(Building|Refreshing) your mixes/)
    expect(fetcher).toHaveBeenCalledWith('/api/mixes/refresh', expect.objectContaining({ method: 'POST', body: '{"force":false}' }))
    finish(reply({ mixes, generatedAt: 2, curatedBy: 'tomify', refreshing: false, stale: false, aiEnabled: false, lastError: null }))
    expect(await screen.findByText('From your listening')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('explains a failed build', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/refresh')
      ? reply({ error: 'mixes-build-failed', message: 'Tomify couldn\'t build your mixes: Navidrome getRandomSongs returned 502.' }, 502)
      : reply({ mixes: [], generatedAt: null, curatedBy: null, refreshing: false, stale: true, aiEnabled: false, lastError: null })))
    renderMixes()
    expect(await screen.findByText(/couldn't build your mixes/)).toBeInTheDocument()
  })
})

describe('Home', () => {
  beforeEach(() => { useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: null }) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends each See all link to the list behind its section', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('getAlbumList2')
      ? reply({ 'subsonic-response': { status: 'ok', albumList2: { album: [{ id: 'al1', name: 'Absolution', artist: 'Muse' }] } } })
      : reply({}, 404)))
    render(<ApiProvider><MemoryRouter><Home/></MemoryRouter></ApiProvider>)
    expect(await screen.findByRole('link', { name: 'See all recently played' })).toHaveAttribute('href', '/albums?type=all&sort=played')
    expect(screen.getByRole('link', { name: 'See all fresh from the shelves' })).toHaveAttribute('href', '/albums?type=all&sort=added')
    expect(screen.getByRole('link', { name: 'See all favourite albums' })).toHaveAttribute('href', '/favourites')
  })
})
