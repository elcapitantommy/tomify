import { create } from 'zustand'
import type { RepeatMode, Track } from '../types'

export interface PlayerState {
  queue: Track[]; currentIndex: number; playing: boolean; shuffle: boolean; repeat: RepeatMode; currentTime: number; duration: number; volume: number; muted: boolean; queueOpen: boolean; nowPlayingOpen: boolean;
  playTracks(tracks: Track[], startIndex?: number): void; playNow(track: Track): void; addToQueue(track: Track): void; removeFromQueue(index: number): void; moveInQueue(from: number, to: number): void; clearQueue(): void; next(): void; previous(): void; setPlaying(value: boolean): void; setProgress(currentTime: number, duration: number): void; seekTo(value: number): void; setVolume(value: number): void; toggleMuted(): void; toggleShuffle(): void; cycleRepeat(): void; setQueueOpen(value: boolean): void; setNowPlayingOpen(value: boolean): void;
}

let seekHandler: ((value: number) => void) | undefined
let volumeHandler: ((value: number, muted: boolean) => void) | undefined
export const bindPlayerRuntime = (handlers: { seek: (value: number) => void; volume: (value: number, muted: boolean) => void }) => { seekHandler = handlers.seek; volumeHandler = handlers.volume; return () => { seekHandler = undefined; volumeHandler = undefined } }

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [], currentIndex: -1, playing: false, shuffle: false, repeat: 'off', currentTime: 0, duration: 0, volume: 0.8, muted: false, queueOpen: false, nowPlayingOpen: false,
  playTracks: (tracks, startIndex = 0) => set({ queue: tracks, currentIndex: tracks.length ? startIndex : -1, playing: tracks.length > 0, currentTime: 0 }),
  playNow: (track) => { const { queue, currentIndex } = get(); const next = [...queue]; next.splice(Math.max(0, currentIndex + 1), 0, track); set({ queue: next, currentIndex: Math.max(0, currentIndex + 1), playing: true, currentTime: 0 }) },
  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track] })),
  removeFromQueue: (index) => set((s) => ({ queue: s.queue.filter((_, i) => i !== index), currentIndex: index < s.currentIndex ? s.currentIndex - 1 : index === s.currentIndex ? Math.min(s.currentIndex, s.queue.length - 2) : s.currentIndex })),
  moveInQueue: (from, to) => set((s) => { const queue = [...s.queue]; const [item] = queue.splice(from, 1); queue.splice(to, 0, item); let currentIndex = s.currentIndex; if (from === currentIndex) currentIndex = to; else if (from < currentIndex && to >= currentIndex) currentIndex--; else if (from > currentIndex && to <= currentIndex) currentIndex++; return { queue, currentIndex } }),
  clearQueue: () => set({ queue: [], currentIndex: -1, playing: false, currentTime: 0, duration: 0 }),
  next: () => set((s) => { if (!s.queue.length) return s; if (s.repeat === 'one') return { currentTime: 0 }; if (s.shuffle && s.queue.length > 1) return { currentIndex: (s.currentIndex + 1 + Math.floor(Math.random() * (s.queue.length - 1))) % s.queue.length, playing: true, currentTime: 0 }; const next = s.currentIndex + 1; return next < s.queue.length ? { currentIndex: next, playing: true, currentTime: 0 } : s.repeat === 'all' ? { currentIndex: 0, playing: true, currentTime: 0 } : { playing: false, currentTime: s.duration } }),
  previous: () => { const s = get(); if (s.currentTime > 3) { s.seekTo(0); return } set({ currentIndex: Math.max(0, s.currentIndex - 1), playing: true, currentTime: 0 }) },
  setPlaying: (playing) => set({ playing }), setProgress: (currentTime, duration) => set({ currentTime, duration }),
  seekTo: (value) => { seekHandler?.(value); set({ currentTime: value }) },
  setVolume: (volume) => { volumeHandler?.(volume, get().muted); set({ volume }) },
  toggleMuted: () => { const muted = !get().muted; volumeHandler?.(get().volume, muted); set({ muted }) },
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })), cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })), setQueueOpen: (queueOpen) => set({ queueOpen }), setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
}))
