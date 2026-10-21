import { create } from 'zustand'
import type { RepeatMode, Track } from '../types'

const PLAYER_STORAGE_KEY = 'tomify-player-v1'

interface PersistedPlayerState {
  queue: Track[]
  currentIndex: number
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  unshuffledQueue?: Track[] | null
}

function loadPersistedPlayer(): PersistedPlayerState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PLAYER_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedPlayerState>
    if (!Array.isArray(value.queue)) return null
    const currentIndex = Number.isInteger(value.currentIndex) ? Number(value.currentIndex) : -1
    const safeIndex = value.queue.length ? Math.min(Math.max(currentIndex, 0), value.queue.length - 1) : -1
    const repeat: RepeatMode = value.repeat === 'all' || value.repeat === 'one' ? value.repeat : 'off'
    return {
      queue: value.queue,
      currentIndex: safeIndex,
      currentTime: Number.isFinite(value.currentTime) ? Math.max(0, Number(value.currentTime)) : 0,
      duration: Number.isFinite(value.duration) ? Math.max(0, Number(value.duration)) : 0,
      volume: Number.isFinite(value.volume) ? Math.max(0, Math.min(1, Number(value.volume))) : 0.8,
      muted: value.muted === true,
      shuffle: value.shuffle === true,
      repeat,
      unshuffledQueue: value.shuffle === true && Array.isArray(value.unshuffledQueue) ? value.unshuffledQueue : null,
    }
  } catch {
    return null
  }
}

const restoredPlayer = loadPersistedPlayer()

function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

// Shuffle reorders the queue once instead of picking a random track on every skip, so each
// song plays once and the one already playing is never queued again. The tracks before the
// current one (already played) stay put; only the upcoming ones are shuffled.
export function shuffleUpcoming(queue: Track[], currentIndex: number): Track[] {
  if (currentIndex < 0) return shuffled(queue)
  return [...queue.slice(0, currentIndex + 1), ...shuffled(queue.slice(currentIndex + 1))]
}

function withoutOne(tracks: Track[], id: string): Track[] {
  const index = tracks.findIndex((track) => track.id === id)
  return index < 0 ? tracks : [...tracks.slice(0, index), ...tracks.slice(index + 1)]
}

export interface PlayerState {
  queue: Track[]; currentIndex: number; playing: boolean; unshuffledQueue: Track[] | null; shuffle: boolean; repeat: RepeatMode; currentTime: number; duration: number; volume: number; muted: boolean; queueOpen: boolean; nowPlayingOpen: boolean; activitySerial: number;
  playTracks(tracks: Track[], startIndex?: number, options?: { keepOrder?: boolean }): void; playNow(track: Track): void; addToQueue(track: Track): void; playNext(tracks: Track[]): void; removeFromQueue(index: number): void; moveInQueue(from: number, to: number): void; clearQueue(): void; next(options?: { pause?: boolean }): void; previous(): void; setPlaying(value: boolean): void; setProgress(currentTime: number, duration: number): void; seekTo(value: number): void; setVolume(value: number): void; toggleMuted(): void; toggleShuffle(): void; cycleRepeat(): void; setQueueOpen(value: boolean): void; setNowPlayingOpen(value: boolean): void;
}

let seekHandler: ((value: number) => void) | undefined
let volumeHandler: ((value: number, muted: boolean) => void) | undefined
let startHandler: ((track: Track) => void) | undefined

export const bindPlayerRuntime = (handlers: {
  seek: (value: number) => void
  volume: (value: number, muted: boolean) => void
  start: (track: Track) => void
}) => {
  seekHandler = handlers.seek
  volumeHandler = handlers.volume
  startHandler = handlers.start
  return () => {
    seekHandler = undefined
    volumeHandler = undefined
    startHandler = undefined
  }
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: restoredPlayer?.queue ?? [], currentIndex: restoredPlayer?.currentIndex ?? -1, playing: false, shuffle: restoredPlayer?.shuffle ?? false, repeat: restoredPlayer?.repeat ?? 'off', currentTime: restoredPlayer?.currentTime ?? 0, duration: restoredPlayer?.duration ?? 0, volume: restoredPlayer?.volume ?? 0.8, muted: restoredPlayer?.muted ?? false, queueOpen: false, nowPlayingOpen: false, activitySerial: 0, unshuffledQueue: restoredPlayer?.unshuffledQueue ?? null,

  playTracks: (tracks, startIndex = 0, options = {}) => {
    const s = get()
    let safeIndex = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1
    const track = safeIndex >= 0 ? tracks[safeIndex] : undefined
    let queue = tracks
    let unshuffledQueue: Track[] | null = null
    if (tracks === s.queue) {
      // Jumping to a track already in the queue keeps the queue (and its shuffle) as it is.
      unshuffledQueue = s.unshuffledQueue
    } else if (s.shuffle && track && !options.keepOrder) {
      // Starting something new with shuffle on: play the chosen track first, the rest in random order.
      unshuffledQueue = tracks
      queue = [track, ...shuffled([...tracks.slice(0, safeIndex), ...tracks.slice(safeIndex + 1)])]
      safeIndex = 0
    }
    set({ queue, unshuffledQueue, currentIndex: safeIndex, playing: Boolean(track), currentTime: 0, duration: track?.duration ?? 0, activitySerial: s.activitySerial + 1 })
    if (track) startHandler?.(track)
  },

  playNow: (track) => {
    const { queue, currentIndex, unshuffledQueue } = get()
    const next = [...queue]
    const nextIndex = Math.max(0, currentIndex + 1)
    next.splice(nextIndex, 0, track)
    let original = unshuffledQueue
    if (original) {
      const current = queue[currentIndex]
      const at = current ? original.findIndex((item) => item.id === current.id) : -1
      original = [...original.slice(0, at + 1), track, ...original.slice(at + 1)]
    }
    set({ queue: next, unshuffledQueue: original, currentIndex: nextIndex, playing: true, currentTime: 0, duration: track.duration ?? 0, activitySerial: get().activitySerial + 1 })
    startHandler?.(track)
  },

  // Puts songs straight after the one playing, in order, without starting them. With nothing queued they start playing.
  playNext: (tracks) => {
    if (!tracks.length) return
    const { queue, currentIndex, unshuffledQueue } = get()
    if (!queue.length || currentIndex < 0) { get().playTracks(tracks, 0, { keepOrder: true }); return }
    const next = [...queue.slice(0, currentIndex + 1), ...tracks, ...queue.slice(currentIndex + 1)]
    let original = unshuffledQueue
    if (original) {
      const current = queue[currentIndex]
      const at = current ? original.findIndex((item) => item.id === current.id) : -1
      original = [...original.slice(0, at + 1), ...tracks, ...original.slice(at + 1)]
    }
    set((s) => ({ queue: next, unshuffledQueue: original, activitySerial: s.activitySerial + 1 }))
  },

  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track], unshuffledQueue: s.unshuffledQueue ? [...s.unshuffledQueue, track] : null, activitySerial: s.activitySerial + 1 })),
  removeFromQueue: (index) => set((s) => ({ queue: s.queue.filter((_, i) => i !== index), unshuffledQueue: s.unshuffledQueue && s.queue[index] ? withoutOne(s.unshuffledQueue, s.queue[index].id) : s.unshuffledQueue, currentIndex: index < s.currentIndex ? s.currentIndex - 1 : index === s.currentIndex ? Math.min(s.currentIndex, s.queue.length - 2) : s.currentIndex, activitySerial: s.activitySerial + 1 })),
  moveInQueue: (from, to) => set((s) => { const queue = [...s.queue]; const [item] = queue.splice(from, 1); queue.splice(to, 0, item); let currentIndex = s.currentIndex; if (from === currentIndex) currentIndex = to; else if (from < currentIndex && to >= currentIndex) currentIndex--; else if (from > currentIndex && to <= currentIndex) currentIndex++; return { queue, currentIndex, activitySerial: s.activitySerial + 1 } }),
  clearQueue: () => set((s) => ({ queue: [], unshuffledQueue: null, currentIndex: -1, playing: false, currentTime: 0, duration: 0, activitySerial: s.activitySerial + 1 })),

  // `pause` moves on to the next song without starting it (the sleep timer stopping at the end of a song).
  next: (options = {}) => {
    const s = get()
    if (!s.queue.length) return
    if (s.repeat === 'one' && !options.pause) {
      s.seekTo(0)
      if (!s.playing) set({ playing: true, activitySerial: s.activitySerial + 1 })
      startHandler?.(s.queue[s.currentIndex])
      return
    }

    let nextIndex = s.currentIndex + 1
    if (nextIndex >= s.queue.length) {
      if (s.repeat === 'all') nextIndex = 0
      else {
        set({ playing: false, currentTime: s.duration, activitySerial: s.activitySerial + 1 })
        return
      }
    }

    const track = s.queue[nextIndex]
    set({ currentIndex: nextIndex, playing: !options.pause, currentTime: 0, duration: track.duration ?? 0, activitySerial: s.activitySerial + 1 })
    startHandler?.(track)
  },

  previous: () => {
    const s = get()
    if (s.currentTime > 3) {
      s.seekTo(0)
      return
    }
    const previousIndex = Math.max(0, s.currentIndex - 1)
    const track = s.queue[previousIndex]
    if (!track) return
    set({ currentIndex: previousIndex, playing: true, currentTime: 0, duration: track.duration ?? 0, activitySerial: s.activitySerial + 1 })
    startHandler?.(track)
  },

  setPlaying: (playing) => {
    set((s) => ({ playing, activitySerial: s.activitySerial + 1 }))
  },
  setProgress: (currentTime, duration) => set({ currentTime, duration }),
  seekTo: (value) => { seekHandler?.(value); set((s) => ({ currentTime: value, activitySerial: s.activitySerial + 1 })) },
  setVolume: (volume) => { volumeHandler?.(volume, get().muted); set((s) => ({ volume, activitySerial: s.activitySerial + 1 })) },
  toggleMuted: () => { const muted = !get().muted; volumeHandler?.(get().volume, muted); set((s) => ({ muted, activitySerial: s.activitySerial + 1 })) },
  toggleShuffle: () => set((s) => {
    const current = s.queue[s.currentIndex]
    if (!s.shuffle) {
      return { shuffle: true, unshuffledQueue: s.queue, queue: shuffleUpcoming(s.queue, s.currentIndex), activitySerial: s.activitySerial + 1 }
    }
    // Turning shuffle off goes back to the original order, carrying on from the current track.
    const original = s.unshuffledQueue
    if (!original || !current) return { shuffle: false, unshuffledQueue: null, activitySerial: s.activitySerial + 1 }
    const index = original.findIndex((track) => track.id === current.id)
    if (index < 0) return { shuffle: false, unshuffledQueue: null, activitySerial: s.activitySerial + 1 }
    return { shuffle: false, unshuffledQueue: null, queue: original, currentIndex: index, activitySerial: s.activitySerial + 1 }
  }),
  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off', activitySerial: s.activitySerial + 1 })),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
}))


if (typeof window !== 'undefined') {
  let persistTimer: number | undefined
  let lastPersistedAt = 0

  const persist = () => {
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const state = usePlayer.getState()
    const snapshot: PersistedPlayerState = {
      queue: state.queue,
      currentIndex: state.currentIndex,
      currentTime: state.currentTime,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
      unshuffledQueue: state.unshuffledQueue,
    }
    try {
      window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(snapshot))
      lastPersistedAt = Date.now()
    } catch { /* storage unavailable */ }
  }

  usePlayer.subscribe(() => {
    const elapsed = Date.now() - lastPersistedAt
    if (elapsed >= 1000) {
      persist()
      return
    }
    if (persistTimer === undefined) persistTimer = window.setTimeout(persist, Math.max(50, 1000 - elapsed))
  })

  window.addEventListener('pagehide', persist)
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist() })
}
