import { create } from 'zustand'

// Star changes made in this session, keyed by item id, so every heart and the Favourites page agree without a reload.
// `version` moves on each confirmed change so pages listing starred music know to refetch.
interface FavouritesState {
  overrides: Record<string, boolean>
  version: number
  setStarred: (id: string, starred: boolean) => void
  confirm: () => void
}

export const useFavourites = create<FavouritesState>((set) => ({
  overrides: {},
  version: 0,
  setStarred: (id, starred) => set((state) => ({ overrides: { ...state.overrides, [id]: starred } })),
  confirm: () => set((state) => ({ version: state.version + 1 })),
}))

export function isStarred(overrides: Record<string, boolean>, item: { id: string; starred?: string }) {
  return overrides[item.id] ?? Boolean(item.starred)
}
