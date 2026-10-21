import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Track } from '../types'
import type { NavidromeClient } from '../lib/navidrome'
import { loadLibrary, smartPool, type SmartRules } from '../lib/smart-playlists'
import { pickRadio } from '../lib/song-radio'
import { usePlayer } from './player'

// The radio tops the queue up when this few songs are left after the current one.
const TOP_UP_AT = 4

// A smart playlist the radio keeps to: only songs its rules match are queued.
export interface RadioPool { name: string; rules: SmartRules }

interface RadioState {
  seed: Track | null
  pool: RadioPool | null
  loading: boolean
  error: string | null
  start(track: Track, pool?: RadioPool | null): Promise<void>
  stop(): void
}

let client: NavidromeClient | null = null
let similarFor: { artistId: string; songs: Promise<Track[]> } | null = null
let topping: Promise<void> | null = null

function similarSongs(api: NavidromeClient, seed: Track) {
  if (!seed.artistId) return Promise.resolve([])
  if (similarFor?.artistId !== seed.artistId) similarFor = { artistId: seed.artistId, songs: api.similarSongs(seed.artistId).catch(() => []) }
  return similarFor.songs
}

function topUp() {
  const { seed, pool } = useRadio.getState()
  if (!seed || !client || topping) return topping ?? Promise.resolve()
  const api = client
  useRadio.setState({ loading: true, error: null })
  topping = (async () => {
    try {
      const [library, similar] = await Promise.all([loadLibrary(api), similarSongs(api, seed)])
      if (useRadio.getState().seed?.id !== seed.id) return
      const player = usePlayer.getState()
      const now = Date.now()
      const picks = pool ? pickRadio(seed, player.queue, smartPool(library, pool.rules, now), smartPool(similar, pool.rules, now)) : pickRadio(seed, player.queue, library, similar)
      if (picks.length) usePlayer.setState({ queue: [...player.queue, ...picks], activitySerial: player.activitySerial + 1 })
      useRadio.setState({ loading: false })
    } catch (error) {
      useRadio.setState({ loading: false, error: error instanceof Error ? error.message : 'Song radio could not load your library.' })
    } finally {
      topping = null
    }
  })()
  return topping
}

export const useRadio = create<RadioState>()(persist((set) => ({
  seed: null,
  pool: null,
  loading: false,
  error: null,
  // Uses the music server client RadioRuntime bound (bindRadio).
  start: async (track, pool = null) => {
    // The radio plays in its own order: shuffle and repeat would fight it.
    usePlayer.setState({ shuffle: false, unshuffledQueue: null, repeat: 'off' })
    set({ seed: track, pool, error: null })
    const player = usePlayer.getState()
    if (player.queue[player.currentIndex]?.id === track.id) {
      // Radio from the song already playing: keep it going from where it is and queue the radio after it.
      usePlayer.setState({ queue: [player.queue[player.currentIndex]], currentIndex: 0, activitySerial: player.activitySerial + 1 })
      if (!player.playing) player.setPlaying(true)
    } else {
      player.playTracks([track], 0, { keepOrder: true })
    }
    await topUp()
  },
  stop: () => set({ seed: null, pool: null, loading: false, error: null }),
}), { name: 'tomify-radio', partialize: (state) => ({ seed: state.seed, pool: state.pool }) }))

// The radio lasts while the queue it built is playing: starting something else or turning shuffle on ends it.
// Otherwise it keeps the queue topped up as it plays.
export function bindRadio(api: NavidromeClient) {
  client = api
  const check = () => {
    const seed = useRadio.getState().seed
    if (!seed) return
    const player = usePlayer.getState()
    if (player.queue[0]?.id !== seed.id || player.shuffle || player.repeat !== 'off') { useRadio.getState().stop(); return }
    if (player.currentIndex >= player.queue.length - 1 - TOP_UP_AT) void topUp()
  }
  check()
  const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.queue !== previous.queue || state.currentIndex !== previous.currentIndex || state.shuffle !== previous.shuffle || state.repeat !== previous.repeat) check() })
  return () => { unsubscribe(); if (client === api) client = null }
}
