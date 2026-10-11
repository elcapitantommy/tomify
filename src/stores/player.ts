import { create } from 'zustand'
import type { RepeatMode, Track } from '../types'

export interface PlayerState {
  queue: Track[]; currentIndex: number; playing: boolean; shuffle: boolean; repeat: RepeatMode; currentTime: number; duration: number; volume: number; muted: boolean; queueOpen: boolean; nowPlayingOpen: boolean;
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
  queue: [], currentIndex: -1, playing: false, shuffle: false, repeat: 'off', currentTime: 0, duration: 0, volume: 0.8, muted: false, queueOpen: false, nowPlayingOpen: false,

  playTracks: (tracks, startIndex = 0) => {
    const safeIndex = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1
    const track = safeIndex >= 0 ? tracks[safeIndex] : undefined
    set({ queue: tracks, currentIndex: safeIndex, playing: Boolean(track), currentTime: 0, duration: track?.duration ?? 0 })
    if (track) startHandler?.(track)
  },

  playNow: (track) => {
    const { queue, currentIndex } = get()
    const next = [...queue]
    const nextIndex = Math.max(0, currentIndex + 1)
    next.splice(nextIndex, 0, track)
    set({ queue: next, currentIndex: nextIndex, playing: true, currentTime: 0, duration: track.duration ?? 0 })
    startHandler?.(track)
  },

  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track] })),
  removeFromQueue: (index) => set((s) => ({ queue: s.queue.filter((_, i) => i !== index), currentIndex: index < s.currentIndex ? s.currentIndex - 1 : index === s.currentIndex ? Math.min(s.currentIndex, s.queue.length - 2) : s.currentIndex })),
  moveInQueue: (from, to) => set((s) => { const queue = [...s.queue]; const [item] = queue.splice(from, 1); queue.splice(to, 0, item); let currentIndex = s.currentIndex; if (from === currentIndex) currentIndex = to; else if (from < currentIndex && to >= currentIndex) currentIndex--; else if (from > currentIndex && to <= currentIndex) currentIndex++; return { queue, currentIndex } }),
  clearQueue: () => set({ queue: [], currentIndex: -1, playing: false, currentTime: 0, duration: 0 }),

  next: () => {
    const s = get()
    if (!s.queue.length) return
    if (s.repeat === 'one') {
      s.seekTo(0)
      if (!s.playing) set({ playing: true })
      startHandler?.(s.queue[s.currentIndex])
      return
    }

    let nextIndex = s.currentIndex + 1
    if (s.shuffle && s.queue.length > 1) nextIndex = (s.currentIndex + 1 + Math.floor(Math.random() * (s.queue.length - 1))) % s.queue.length
    else if (nextIndex >= s.queue.length) {
      if (s.repeat === 'all') nextIndex = 0
      else {
        set({ playing: false, currentTime: s.duration })
        return
      }
    }

    const track = s.queue[nextIndex]
    set({ currentIndex: nextIndex, playing: true, currentTime: 0, duration: track.duration ?? 0 })
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
    set({ currentIndex: previousIndex, playing: true, currentTime: 0, duration: track.duration ?? 0 })
    startHandler?.(track)
  },

  setPlaying: (playing) => {
    const track = get().queue[get().currentIndex]
    set({ playing })
    if (playing && track) startHandler?.(track)
  },
  setProgress: (currentTime, duration) => set({ currentTime, duration }),
  seekTo: (value) => { seekHandler?.(value); set({ currentTime: value }) },
  setVolume: (volume) => { volumeHandler?.(volume, get().muted); set({ volume }) },
  toggleMuted: () => { const muted = !get().muted; volumeHandler?.(get().volume, muted); set({ muted }) },
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
}))
