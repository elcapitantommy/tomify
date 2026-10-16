import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { PlayerRuntime } from './PlayerRuntime'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const tracks = [
  { id: 'a', title: 'Ana Ng', artist: 'They Might Be Giants', album: 'Lincoln', duration: 200 },
  { id: 'b', title: 'Purple Toupee', artist: 'They Might Be Giants', album: 'Lincoln', duration: 180 },
]
let requests: string[]

const audio = () => Array.from(document.querySelectorAll('audio'))
const streamed = (element: HTMLAudioElement) => new URL(element.src || 'https://none.example/').searchParams.get('id')

describe('PlayerRuntime', () => {
  beforeEach(() => {
    requests = []
    useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false })
    usePlayer.setState({ queue: tracks, currentIndex: 0, playing: false, currentTime: 0, duration: 200, shuffle: false, repeat: 'off' })
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => { requests.push(String(url)); return Response.json({ 'subsonic-response': { status: 'ok' } }) }))
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('only fetches metadata for a restored, paused queue and does not download the next track', async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    const [current, standby] = audio()
    expect(streamed(current)).toBe('a')
    expect(current.preload).toBe('metadata')
    expect(standby.getAttribute('src')).toBeNull()
    expect(requests.some((url) => url.includes('/rest/scrobble.view'))).toBe(false)
  })

  it('buffers the track and primes the next one once playback starts', async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/></ApiProvider>) })
    await act(async () => { usePlayer.getState().setPlaying(true) })
    const [current, standby] = audio()
    expect(current.preload).toBe('auto')
    expect(streamed(standby)).toBe('b')
    expect(standby.preload).toBe('auto')
    expect(requests.filter((url) => url.includes('/rest/scrobble.view') && url.includes('submission=false'))).toHaveLength(1)
  })
})
