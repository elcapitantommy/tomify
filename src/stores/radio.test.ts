import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'
import type { NavidromeClient } from '../lib/navidrome'
import { bindPlayerRuntime, usePlayer } from './player'
import { bindRadio, useRadio } from './radio'

const library: Track[] = Array.from({ length: 40 }, (_, index) => ({ id: `l${index}`, title: `Track ${index}`, artist: `Artist ${index % 10}`, album: 'A', genre: index % 2 ? 'Rock' : 'Pop' }))
vi.mock('../lib/smart-playlists', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/smart-playlists')>(), loadLibrary: async () => library }))

const seed: Track = { id: 'seed', title: 'Seed song', artist: 'Seed artist', artistId: 'ar1', album: 'S', genre: 'Rock' }
const api = { similarSongs: vi.fn(async () => [library[3]]) } as unknown as NavidromeClient

describe('song radio', () => {
  let unbind: () => void
  beforeEach(() => {
    usePlayer.setState({ queue: [], currentIndex: -1, playing: false, shuffle: true, repeat: 'all' })
    useRadio.setState({ seed: null, pool: null, loading: false, error: null })
    unbind = bindRadio(api)
  })
  afterEach(() => unbind())

  it('plays the song, then queues similar songs from the library, keeping shuffle and repeat off', async () => {
    await useRadio.getState().start(seed)
    const player = usePlayer.getState()
    expect(player.queue[0]).toBe(seed)
    expect(player.currentIndex).toBe(0)
    expect(player.shuffle).toBe(false)
    expect(player.repeat).toBe('off')
    expect(player.queue.length).toBe(16)
    expect(player.queue[1]).toBe(library[3])
    expect(useRadio.getState().loading).toBe(false)
  })

  it('tops the queue up as it plays and ends when something else is played', async () => {
    await useRadio.getState().start(seed)
    usePlayer.setState({ currentIndex: 12 })
    await vi.waitFor(() => expect(usePlayer.getState().queue.length).toBe(31))
    expect(new Set(usePlayer.getState().queue.map((track) => track.id)).size).toBe(31)
    usePlayer.getState().playTracks([library[0]])
    expect(useRadio.getState().seed).toBeNull()
  })

  it('ends when shuffle is turned on', async () => {
    await useRadio.getState().start(seed)
    usePlayer.getState().toggleShuffle()
    expect(useRadio.getState().seed).toBeNull()
  })

  it('keeps to a smart playlist: only songs its rules match are queued, similar songs included', async () => {
    await useRadio.getState().start(seed, { name: 'Pop', rules: { genres: ['pop'] } })
    const queued = usePlayer.getState().queue.slice(1)
    expect(queued.length).toBe(15)
    expect(queued.every((track) => track.genre === 'Pop')).toBe(true)
    expect(queued).not.toContain(library[3])
    expect(useRadio.getState().pool?.name).toBe('Pop')
    useRadio.getState().stop()
    expect(useRadio.getState().pool).toBeNull()
  })
  it('keeps the playing song going from where it is when radio starts from it', async () => {
    const start = vi.fn()
    const unbindRuntime = bindPlayerRuntime({ seek: vi.fn(), volume: vi.fn(), start })
    usePlayer.setState({ queue: [library[0], seed, library[1]], currentIndex: 1, playing: true, currentTime: 42, duration: 200, shuffle: false, repeat: 'off' })
    await useRadio.getState().start(seed)
    const player = usePlayer.getState()
    expect(start).not.toHaveBeenCalled()
    expect(player.queue[0]).toBe(seed)
    expect(player.currentIndex).toBe(0)
    expect(player.currentTime).toBe(42)
    expect(player.playing).toBe(true)
    expect(player.queue.length).toBe(16)
    expect(useRadio.getState().seed).toBe(seed)
    unbindRuntime()
  })
})
