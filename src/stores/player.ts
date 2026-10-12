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
    }
  } catch {
    return null
  }
}

const restoredPlayer = loadPersistedPlayer()

export interface PlayerState {
  queue: Track[]; currentIndex: number; playing: boolean; shuffle: boolean; repeat: RepeatMode; currentTime: number; duration: number; volume: number; muted: boolean; queueOpen: boolean; nowPlayingOpen: boolean; activitySerial: number;
  playTracks(tracks: Track[], startIndex?: number): void; playNow(track: Track): void; addToQueue(track: Track): void; removeFromQueue(index: number): void; moveInQueue(from: number, to: number): void; clearQueue(): void; next(): void; previous(): void; setPlaying(value: boolean): void; setProgress(currentTime: number, duration: number): void; seekTo(value: number): void; setVolume(value: number): void; toggleMuted(): void; toggleShuffle(): void; cycleRepeat(): void; setQueueOpen(value: boolean): void; setNowPlayingOpen(value: boolean): void;
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
  queue: restoredPlayer?.queue ?? [], currentIndex: restoredPlayer?.currentIndex ?? -1, playing: false, shuffle: restoredPlayer?.shuffle ?? false, repeat: restoredPlayer?.repeat ?? 'off', currentTime: restoredPlayer?.currentTime ?? 0, duration: restoredPlayer?.duration ?? 0, volume: restoredPlayer?.volume ?? 0.8, muted: restoredPlayer?.muted ?? false, queueOpen: false, nowPlayingOpen: false, activitySerial: 0,

  playTracks: (tracks, startIndex = 0) => {
    const safeIndex = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1
    const track = safeIndex >= 0 ? tracks[safeIndex] : undefined
    set({ queue: tracks, currentIndex: safeIndex, playing: Boolean(track), currentTime: 0, duration: track?.duration ?? 0, activitySerial: get().activitySerial + 1 })
    if (track) startHandler?.(track)
  },

  playNow: (track) => {
    const { queue, currentIndex } = get()
    const next = [...queue]
    const nextIndex = Math.max(0, currentIndex + 1)
    next.splice(nextIndex, 0, track)
    set({ queue: next, currentIndex: nextIndex, playing: true, currentTime: 0, duration: track.duration ?? 0, activitySerial: get().activitySerial + 1 })
    startHandler?.(track)
  },

  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track], activitySerial: s.activitySerial + 1 })),
  removeFromQueue: (index) => set((s) => ({ queue: s.queue.filter((_, i) => i !== index), currentIndex: index < s.currentIndex ? s.currentIndex - 1 : index === s.currentIndex ? Math.min(s.currentIndex, s.queue.length - 2) : s.currentIndex, activitySerial: s.activitySerial + 1 })),
  moveInQueue: (from, to) => set((s) => { const queue = [...s.queue]; const [item] = queue.splice(from, 1); queue.splice(to, 0, item); let currentIndex = s.currentIndex; if (from === currentIndex) currentIndex = to; else if (from < currentIndex && to >= currentIndex) currentIndex--; else if (from > currentIndex && to <= currentIndex) currentIndex++; return { queue, currentIndex, activitySerial: s.activitySerial + 1 } }),
  clearQueue: () => set((s) => ({ queue: [], currentIndex: -1, playing: false, currentTime: 0, duration: 0, activitySerial: s.activitySerial + 1 })),

  next: () => {
    const s = get()
    if (!s.queue.length) return
    if (s.repeat === 'one') {
      s.seekTo(0)
      if (!s.playing) set({ playing: true, activitySerial: s.activitySerial + 1 })
      startHandler?.(s.queue[s.currentIndex])
      return
    }

    let nextIndex = s.currentIndex + 1
    if (s.shuffle && s.queue.length > 1) nextIndex = (s.currentIndex + 1 + Math.floor(Math.random() * (s.queue.length - 1))) % s.queue.length
    else if (nextIndex >= s.queue.length) {
      if (s.repeat === 'all') nextIndex = 0
      else {
        set({ playing: false, currentTime: s.duration, activitySerial: s.activitySerial + 1 })
        return
      }
    }

    const track = s.queue[nextIndex]
    set({ currentIndex: nextIndex, playing: true, currentTime: 0, duration: track.duration ?? 0, activitySerial: s.activitySerial + 1 })
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
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle, activitySerial: s.activitySerial + 1 })),
  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off', activitySerial: s.activitySerial + 1 })),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
}))


if (typeof window !== 'undefined') {
  let persistTimer: number | undefined
  const persist = () => {
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
    }
    try { window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(snapshot)) } catch { /* storage unavailable */ }
  }

  usePlayer.subscribe(() => {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(persist, 250)
  })
  window.addEventListener('pagehide', persist)
}
