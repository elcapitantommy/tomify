import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const MAX_CROSSFADE_SECONDS = 12

// Seconds the end of one song overlaps the start of the next; 0 plays them back to back (gapless).
interface CrossfadeState { seconds: number; setSeconds(seconds: number): void }

export const useCrossfade = create<CrossfadeState>()(persist((set) => ({
  seconds: 0,
  setSeconds: (seconds) => set({ seconds: Math.round(Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, seconds))) }),
}), { name: 'tomify-crossfade' }))
