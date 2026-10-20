import { create } from 'zustand'
import type { CastKind, CastState } from '../lib/cast'

// What the player bar shows about casting; PlayerRuntime owns the audio elements and fills this in.
interface CastStoreState {
  kind: CastKind | null
  state: CastState
  error: string | null
  set(fields: Partial<Pick<CastStoreState, 'kind' | 'state' | 'error'>>): void
}

export const useCast = create<CastStoreState>((set) => ({
  kind: null,
  state: 'disconnected',
  error: null,
  set: (fields) => set(fields),
}))

let promptHandler: (() => void) | undefined
export function bindCastPrompt(handler: () => void) { promptHandler = handler; return () => { if (promptHandler === handler) promptHandler = undefined } }
// Must run inside the click that asked for it: browsers only show their speaker picker for a user gesture.
export function promptCast() { promptHandler?.() }
