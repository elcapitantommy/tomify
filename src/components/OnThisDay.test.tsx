import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { OnThisDay } from './OnThisDay'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const reply = (body: object) => new Response(JSON.stringify(body))
const today = new Date(2026, 9, 21, 9)
const renderSection = () => render(<ApiProvider><MemoryRouter><OnThisDay today={today}/></MemoryRouter></ApiProvider>)

describe('On this day', () => {
  beforeEach(() => { localStorage.clear(); useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false }) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows albums released on this date and what was played a year ago, and keeps the albums for the day', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('getAlbumList2')) return reply({ 'subsonic-response': { status: 'ok', albumList2: { album: [{ id: 'al1', name: 'Absolution', artist: 'Muse', releaseDate: '2001-10-21' }, { id: 'al2', name: 'Drones', artist: 'Muse', releaseDate: '2015-06-05' }] } } })
      if (url.includes('/api/listening/stats')) return reply({ albums: [{ plays: 4, seconds: 900, album: 'Flood', albumId: 'al9', artist: 'They Might Be Giants' }] })
      return reply({})
    })
    vi.stubGlobal('fetch', fetcher)
    const { unmount } = renderSection()
    expect(await screen.findByText('Absolution')).toBeInTheDocument()
    expect(screen.getByText(/25 years ago today/)).toBeInTheDocument()
    expect(screen.queryByText('Drones')).toBeNull()
    expect(await screen.findByRole('link', { name: 'Flood' })).toHaveAttribute('href', '/albums/al9')
    const statsCall = fetcher.mock.calls.map(([input]) => String(input)).find((url) => url.includes('/api/listening/stats'))!
    expect(statsCall).toContain(`from=${new Date(2025, 9, 21).getTime()}`)
    unmount()
    const albumCalls = () => fetcher.mock.calls.filter(([input]) => String(input).includes('getAlbumList2')).length
    const before = albumCalls()
    renderSection()
    expect(await screen.findByText('Absolution')).toBeInTheDocument()
    expect(albumCalls()).toBe(before)
  })

  it('shows nothing when there is nothing for today', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('getAlbumList2')
      ? reply({ 'subsonic-response': { status: 'ok', albumList2: { album: [] } } })
      : reply({ albums: [] })))
    const { container } = renderSection()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container).toBeEmptyDOMElement()
  })
})
