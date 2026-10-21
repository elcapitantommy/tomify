import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { nextVisualiserMode, type VisualiserMode } from '../lib/visualiser'

interface VisualiserState {
  mode: VisualiserMode
  setMode(mode: VisualiserMode): void
  cycle(): void
}

// Per device: a phone may not want to spend battery on it.
export const useVisualiser = create<VisualiserState>()(persist((set) => ({
  mode: 'off',
  setMode: (mode) => set({ mode }),
  cycle: () => set((state) => ({ mode: nextVisualiserMode(state.mode) })),
}), { name: 'tomify-visualiser', partialize: ({ mode }) => ({ mode }) }))
