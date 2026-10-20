import { create } from 'zustand'

// Star ratings (1-5, 0 = none) set in this session, keyed by song or album id, so every
// rating control agrees without a reload. Navidrome keeps the ratings themselves.
interface RatingsState {
  overrides: Record<string, number>
  setRating: (id: string, rating: number) => void
}

export const useRatings = create<RatingsState>((set) => ({
  overrides: {},
  setRating: (id, rating) => set((state) => ({ overrides: { ...state.overrides, [id]: rating } })),
}))

export function ratingOf(overrides: Record<string, number>, item: { id: string; userRating?: number }) {
  return overrides[item.id] ?? item.userRating ?? 0
}

// Picking the rating already set clears it, like tapping a lit star again in most music apps.
export function nextRating(current: number, picked: number) {
  return picked === current ? 0 : picked
}
