import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'
import type { NavidromeClient } from '../lib/navidrome'
import { usePlayer } from './player'
import { bindRadio, useRadio } from './radio'

const library: Track[] = Array.from({ length: 40 }, (_, index) => ({ id: `l${index}`, title: `Track ${index}`, artist: `Artist ${index % 10}`, album: 'A', genre: index % 2 ? 'Rock' : 'Pop' }))
vi.mock('../lib/smart-playlists', () => ({ loadLibrary: async () => library }))

const seed: Track = { id: 'seed', title: 'Seed song', artist: 'Seed artist', artistId: 'ar1', album: 'S', genre: 'Rock' }
const api = { similarSongs: vi.fn(async () => [library[3]]) } as unknown as NavidromeClient

describe('song radio', () => {
  let unbind: () => void
  beforeEach(() => {
    usePlayer.setState({ queue: [], currentIndex: -1, playing: false, shuffle: true, repeat: 'all' })
    useRadio.setState({ seed: null, loading: false, error: null })
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
})
