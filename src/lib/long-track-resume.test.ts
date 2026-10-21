import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '../stores/player'
import { useBookmarks } from '../stores/bookmarks'
import { followPlayer } from './long-track-resume'

const set = { id: 'set', title: 'Live at Wembley', artist: 'Queen', album: 'Live', duration: 3600 }
const song = { id: 'song', title: 'Radio Ga Ga', artist: 'Queen', album: 'The Works', duration: 343 }
const api = { bookmarks: vi.fn(async () => [{ entry: set, position: 900_000 }, { entry: song, position: 60_000 }]), createBookmark: vi.fn(async () => undefined), deleteBookmark: vi.fn(async () => undefined) }

describe('remembering the place in long tracks', () => {
  let stop: () => void
  beforeEach(async () => {
    api.createBookmark.mockClear(); api.deleteBookmark.mockClear()
    usePlayer.setState({ queue: [song, set], currentIndex: 0, playing: true, currentTime: 0, duration: 343 })
    await useBookmarks.getState().load(api)
    stop = followPlayer(api)
  })
  afterEach(() => { stop(); useBookmarks.setState({ positions: {} }) })

  it('loads saved places for long tracks only', () => {
    expect(useBookmarks.getState().positions).toEqual({ set: 900 })
  })

  it('picks up a long track from its saved place once it starts playing', () => {
    const seek = vi.spyOn(usePlayer.getState(), 'seekTo')
    usePlayer.getState().next()
    expect(seek).not.toHaveBeenCalled()
    usePlayer.getState().setProgress(0.4, 3600)
    expect(seek).toHaveBeenCalledWith(900)
    expect(usePlayer.getState().currentTime).toBe(900)
  })

  it('saves every 30 seconds, on pause and when moving on, and forgets a finished track', () => {
    usePlayer.setState({ currentIndex: 1, currentTime: 0, duration: 3600 })
    usePlayer.setState({ currentTime: 1000 })
    expect(api.createBookmark).toHaveBeenLastCalledWith('set', 1_000_000)
    usePlayer.setState({ currentTime: 1010 })
    expect(api.createBookmark).toHaveBeenCalledTimes(1)
    usePlayer.setState({ currentTime: 1031 })
    expect(api.createBookmark).toHaveBeenLastCalledWith('set', 1_031_000)
    usePlayer.setState({ playing: false, currentTime: 1040 })
    expect(api.createBookmark).toHaveBeenLastCalledWith('set', 1_040_000)
    expect(useBookmarks.getState().positions.set).toBe(1040)
    usePlayer.setState({ playing: true, currentTime: 3590 })
    usePlayer.setState({ queue: [song, set, song], currentIndex: 2, currentTime: 0 })
    expect(api.deleteBookmark).toHaveBeenCalledWith('set')
    expect(useBookmarks.getState().positions).toEqual({})
  })

  it('leaves ordinary songs alone', () => {
    usePlayer.setState({ currentTime: 200 })
    usePlayer.setState({ playing: false })
    usePlayer.getState().next()
    expect(api.createBookmark).not.toHaveBeenCalled()
  })
})
