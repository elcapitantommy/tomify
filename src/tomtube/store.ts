// TomTube's state: the queue, recently watched, settings (kept on this device) and what the player
// is doing right now (not kept).
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { emptyQueue, type HistoryEntry, type QueueState } from './queue'

export type PlaybackMode = 'video' | 'audio'
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

export interface TomTubeSettings {
  // Switch to audio by itself when the phone locks or TomTube goes to the background during a video.
  backgroundAudio: boolean
  // Audio mode plays the queue as one continuous stream from the server (experimental; see docs/TOMTUBE.md).
  continuousQueue: boolean
  // 'auto' plays HLS (up to 1080p) where the browser supports it; 'compatible' always plays the single 360p MP4.
  videoQuality: 'auto' | 'compatible'
  // 'auto' plays audio as HLS where supported; 'file' always plays the single M4A file.
  audioFormat: 'auto' | 'file'
}

export interface PlayerView {
  mode: PlaybackMode
  playing: boolean
  status: PlayerStatus
  error: string | null
  currentTime: number
  duration: number
  source: 'hls' | 'file' | null
  continuous: boolean
  // Set while audio mode was entered by locking the phone, so video comes back when TomTube does.
  autoAudio: boolean
}

interface TomTubeState {
  queue: QueueState
  history: HistoryEntry[]
  settings: TomTubeSettings
  player: PlayerView
  expanded: boolean
  setQueue(queue: QueueState): void
  setHistory(history: HistoryEntry[]): void
  setSettings(settings: Partial<TomTubeSettings>): void
  setPlayer(player: Partial<PlayerView>): void
  setExpanded(expanded: boolean): void
  clearHistory(): void
}

export const defaultSettings: TomTubeSettings = { backgroundAudio: true, continuousQueue: false, videoQuality: 'auto', audioFormat: 'auto' }
export const initialPlayer: PlayerView = { mode: 'video', playing: false, status: 'idle', error: null, currentTime: 0, duration: 0, source: null, continuous: false, autoAudio: false }

export const useTomTube = create<TomTubeState>()(persist((set) => ({
  queue: emptyQueue,
  history: [],
  settings: defaultSettings,
  player: initialPlayer,
  expanded: false,
  setQueue: (queue) => set({ queue }),
  setHistory: (history) => set({ history }),
  setSettings: (settings) => set((state) => ({ settings: { ...state.settings, ...settings } })),
  setPlayer: (player) => set((state) => ({ player: { ...state.player, ...player } })),
  setExpanded: (expanded) => set({ expanded }),
  clearHistory: () => set({ history: [] }),
}), {
  name: 'tomtube',
  version: 1,
  partialize: ({ queue, history, settings, player }) => ({ queue, history, settings, player: { mode: player.mode } }),
  merge: (persisted, current) => {
    const saved = (persisted || {}) as Partial<TomTubeState> & { player?: Partial<PlayerView> }
    return { ...current, ...saved, settings: { ...defaultSettings, ...saved.settings }, player: { ...initialPlayer, mode: saved.player?.mode === 'audio' ? 'audio' : 'video' } }
  },
}))
