import type { Track } from '../types'

// Gapless: the next song is started this long before the current one ends, which covers the time a paused
// element takes to start. Most files end in a little silence or encoder padding, so nothing is heard twice.
export const GAPLESS_LEAD_SECONDS = 0.12

// How long the hand-over from `current` to `next` should fade over. Songs that run into each other on an album
// (live and continuous albums) stay gapless, and so does a DJ set, whose links sit between the songs.
export function crossfadeSeconds(current: Track, next: Track, setting: number, options: { canFade: boolean; dj: boolean }) {
  if (setting <= 0 || !options.canFade || options.dj) return 0
  if (current.albumId && current.albumId === next.albumId) return 0
  // Never longer than half of either song.
  const shortest = Math.min(current.duration || Infinity, next.duration || Infinity)
  return Math.max(0, Math.min(setting, shortest / 2))
}

// Equal-power curves keep the loudness steady through the fade. `progress` runs from 0 to 1.
export const fadeOutLevel = (progress: number) => Math.cos(Math.min(1, Math.max(0, progress)) * Math.PI / 2)
export const fadeInLevel = (progress: number) => Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI / 2)

// iPhone and iPad ignore a media element's volume (the hardware buttons own it), so nothing can fade there.
export function volumeCanFade() {
  if (typeof Audio === 'undefined') return false
  try { const probe = new Audio(); probe.volume = 0.5; return Math.abs(probe.volume - 0.5) < 0.01 } catch { return false }
}
