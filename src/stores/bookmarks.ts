import { create } from 'zustand'
import type { NavidromeClient } from '../lib/navidrome'

export type BookmarkApi = Pick<NavidromeClient, 'bookmarks' | 'createBookmark' | 'deleteBookmark'>
import { isLongTrack } from '../lib/long-tracks'

// Saved positions in long tracks, by song id, in seconds (see lib/long-tracks.ts).
interface BookmarksState {
  positions: Record<string, number>
  load(api: BookmarkApi): Promise<void>
  save(api: BookmarkApi, trackId: string, seconds: number): Promise<void>
  clear(api: BookmarkApi, trackId: string): Promise<void>
}

export const useBookmarks = create<BookmarksState>()((set, get) => ({
  positions: {},
  load: async (api: BookmarkApi) => {
    const bookmarks = await api.bookmarks()
    const positions: Record<string, number> = {}
    for (const bookmark of bookmarks) if (bookmark.entry?.id && isLongTrack(bookmark.entry.duration)) positions[bookmark.entry.id] = bookmark.position / 1000
    set({ positions })
  },
  save: async (api, trackId, seconds) => {
    set((state) => ({ positions: { ...state.positions, [trackId]: seconds } }))
    await api.createBookmark(trackId, seconds * 1000)
  },
  clear: async (api, trackId) => {
    if (!(trackId in get().positions)) return
    set((state) => { const positions = { ...state.positions }; delete positions[trackId]; return { positions } })
    await api.deleteBookmark(trackId)
  },
}))
