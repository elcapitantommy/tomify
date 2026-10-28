import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TomTubeApp } from './App'
import { useAuth } from '../stores/auth'
import { useTomTube, defaultSettings, initialPlayer } from './store'
import { emptyQueue } from './queue'
import { formatDuration, formatViews, youtubeLinkId } from './api'

const session = { serverUrl: 'https://tomify.tomdixon.uk', username: 'tom', token: '0123456789abcdef0123456789abcdef', salt: 'abc123' }
const results = [
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Rick Astley', duration: 213, viewCount: 1_500_000_000 },
  { id: 'aaaaaaaaaaa', title: 'Second video', channel: 'Someone', duration: 65, viewCount: 1200 },
]

beforeEach(() => {
  useTomTube.setState({ queue: emptyQueue, history: [], settings: { ...defaultSettings }, player: { ...initialPlayer }, expanded: false })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ session: null, status: 'signed-out' })
})

describe('TomTube app', () => {
  it('asks for the Tomify sign-in first', () => {
    useAuth.setState({ session: null, status: 'signed-out' })
    render(<TomTubeApp/>)
    expect(screen.getByText('Sign in with your Tomify account.')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
  })

  it('searches, shows results and plays one through Tomify', async () => {
    useAuth.setState({ session, status: 'signed-in' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/media-session')) return new Response('{}', { status: 404 })
      if (url.startsWith('/api/tomtube/search')) {
        expect(new Headers(init?.headers).get('x-tomify-user')).toBe('tom')
        return Response.json({ query: 'rick', results })
      }
      if (url.includes('/prefetch')) return Response.json({ state: 'started' }, { status: 202 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    const { container } = render(<TomTubeApp/>)
    expect(screen.getByText(/Search for a video or paste a YouTube link/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search YouTube'), 'rick{Enter}')
    expect(await screen.findByText('Never Gonna Give You Up')).toBeInTheDocument()
    expect(screen.getByText('Rick Astley · 1.5B views')).toBeInTheDocument()
    expect(screen.getByText('3:33')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/tomtube/search?q=rick')).toBe(true)

    await user.click(screen.getByText('Never Gonna Give You Up'))
    const video = container.querySelector('video')!
    await waitFor(() => expect(video.getAttribute('src')).toMatch(/^\/api\/tomtube\/videos\/dQw4w9WgXcQ\/(?:master\.m3u8|progressive\.mp4)\?u=tom&/))
    expect(screen.getByRole('heading', { level: 1, name: 'Never Gonna Give You Up' })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Audio only/ }))
    const audio = container.querySelector('audio')!
    expect(audio.getAttribute('src')).toMatch(/\/videos\/dQw4w9WgXcQ\/audio\.(?:m3u8|m4a)\?/)
    expect(video.getAttribute('src')).toBeNull()
    expect(useTomTube.getState().player.mode).toBe('audio')
    expect(useTomTube.getState().history[0].id).toBe('dQw4w9WgXcQ')
    vi.unstubAllGlobals()
  })

  it('queues videos to play next', async () => {
    useAuth.setState({ session, status: 'signed-in' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/tomtube/search') ? Response.json({ query: 'x', results }) : new Response('{}', { status: 404 })))
    const user = userEvent.setup()
    render(<TomTubeApp/>)
    await user.type(screen.getByLabelText('Search YouTube'), 'x{Enter}')
    await screen.findByText('Second video')
    await user.click(screen.getAllByRole('button', { name: 'More' })[1])
    await user.click(screen.getByRole('button', { name: 'Add to queue' }))
    expect(useTomTube.getState().queue.items.map((item) => item.id)).toEqual(['aaaaaaaaaaa'])
    vi.unstubAllGlobals()
  })
})

describe('TomTube helpers', () => {
  it('recognises pasted YouTube links', () => {
    expect(youtubeLinkId('https://youtu.be/dQw4w9WgXcQ?si=1')).toBe('dQw4w9WgXcQ')
    expect(youtubeLinkId('youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(youtubeLinkId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(youtubeLinkId('rick astley')).toBeNull()
  })

  it('formats durations and view counts', () => {
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(null)).toBe('')
    expect(formatViews(1200)).toBe('1.2K views')
    expect(formatViews(2_000_000)).toBe('2M views')
  })
})
