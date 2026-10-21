// Long tracks (live sets, DJ mixes, audiobook chapters) carry on from where you stopped.
// Positions are kept as Navidrome bookmarks, so every device signed in to the account sees them.

export const LONG_TRACK_SECONDS = 20 * 60
// Positions are saved this often while a long track plays, as well as on pause and when the song changes.
export const SAVE_EVERY_SECONDS = 30
// Near the start nothing is worth resuming; near the end the track counts as finished.
const START_MARGIN = 30
const END_MARGIN = 60

export const isLongTrack = (duration?: number) => (duration ?? 0) >= LONG_TRACK_SECONDS

// Where to pick up, or null to start from the beginning.
export function resumePosition(saved: number | undefined, duration?: number): number | null {
  if (!saved || !isLongTrack(duration) || saved < START_MARGIN || saved > (duration ?? 0) - END_MARGIN) return null
  return saved
}

export type BookmarkAction = { kind: 'save'; position: number } | { kind: 'clear' } | null

// What stopping at `position` means for the bookmark: keep it, drop it (finished), or leave it alone (barely started).
export function bookmarkActionAt(position: number, duration?: number): BookmarkAction {
  if (!isLongTrack(duration)) return null
  if (position >= (duration ?? 0) - END_MARGIN) return { kind: 'clear' }
  if (position < START_MARGIN) return null
  return { kind: 'save', position: Math.floor(position) }
}
