import { create } from 'zustand'
import type { RadioStation } from '../lib/internet-radio'

// The radio station playing on this device. Live radio has its own audio element (components/LiveRadio.tsx),
// separate from the music player: starting one stops the other.
interface LiveRadioState {
  station: RadioStation | null
  status: 'idle' | 'loading' | 'playing' | 'error'
  error: string | null
  play(station: RadioStation): void
  stop(): void
  setStatus(status: LiveRadioState['status'], error?: string | null): void
}

export const useLiveRadio = create<LiveRadioState>((set) => ({
  station: null,
  status: 'idle',
  error: null,
  play: (station) => set({ station, status: 'loading', error: null }),
  stop: () => set({ station: null, status: 'idle', error: null }),
  setStatus: (status, error = null) => set({ status, error }),
}))
