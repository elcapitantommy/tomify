import { create } from 'zustand'

// Car mode stays on across reloads, so reopening Tomify on the dashboard goes straight back to it.
const KEY = 'tomify-car-mode'
const saved = () => { try { return window.localStorage.getItem(KEY) === '1' } catch { return false } }

interface CarModeState { open: boolean; setOpen(open: boolean): void }

export const useCarMode = create<CarModeState>((set) => ({
  open: typeof window !== 'undefined' && saved(),
  setOpen: (open) => {
    try { window.localStorage.setItem(KEY, open ? '1' : '0') } catch { /* storage unavailable */ }
    set({ open })
  },
}))
