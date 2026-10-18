import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from './auth'
import { usePlayer } from './player'
import { bindDj, djVoiceElement, useDj } from './dj'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const track = (id: string) => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, album: 'Album' })
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

describe('Tomify DJ', () => {
  let unbind: () => void
  let play: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    useAuth.setState({ session })
    usePlayer.setState({ queue: [], currentIndex: -1, playing: false, shuffle: true })
    useDj.setState({ active: false, loading: false, speaking: false, script: null, error: null, request: null, pending: null, trackIds: [] })
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice'), revokeObjectURL: vi.fn() }))
    unbind = bindDj()
  })
  afterEach(() => { unbind(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('holds the first song while the DJ talks, then plays it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/voice')
      ? new Response(new Blob(['mp3']), { status: 200 })
      : json({ tracks: [track('a'), track('b'), track('c')], script: 'Morning Tom.', curatedBy: 'claude', voice: true }))
    vi.stubGlobal('fetch', fetcher)
    await useDj.getState().start()

    expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(usePlayer.getState().shuffle).toBe(false)
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: true, script: 'Morning Tom.', pending: null }))
    expect(usePlayer.getState().playing).toBe(false)
    expect(djVoiceElement()?.src).toBe('blob:voice')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ recentTrackIds: [], recentArtists: [], request: null, first: true })

    djVoiceElement()?.onended?.(new Event('ended'))
    expect(useDj.getState().speaking).toBe(false)
    expect(usePlayer.getState().playing).toBe(true)
    expect(play).toHaveBeenCalled()
  })

  it('fetches the next set near the end of the current one and stops when something else is played', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return json(body.first ? { tracks: [track('a'), track('b')], script: '', curatedBy: 'tomify', voice: false } : { tracks: [track('d'), track('e')], script: 'Next up.', curatedBy: 'tomify', voice: false })
    })
    vi.stubGlobal('fetch', fetcher)
    await useDj.getState().start()
    expect(usePlayer.getState().playing).toBe(true)
    await vi.waitFor(() => expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'd', 'e']))
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(expect.objectContaining({ recentTrackIds: ['a', 'b'], recentArtists: ['Artist a', 'Artist b'] }))

    usePlayer.getState().playTracks([track('z')])
    expect(useDj.getState().active).toBe(false)
  })

  it('starts while something else is already in the player', async () => {
    usePlayer.setState({ queue: [track('x')], currentIndex: 0, playing: true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice')
      ? new Response(new Blob(['mp3']), { status: 200 })
      : json({ tracks: [track('a'), track('b'), track('c')], script: 'Evening Tom.', curatedBy: 'claude', voice: true })))
    const starting = useDj.getState().start()
    usePlayer.getState().setProgress(12, 200)
    await starting

    expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: true, script: 'Evening Tom.' }))
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('reports a failed start without leaving the DJ on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'The DJ couldn\'t pick the next songs: Navidrome is down.' }, 502)))
    await useDj.getState().start()
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: false, error: 'The DJ couldn\'t pick the next songs: Navidrome is down.' }))
  })
})
