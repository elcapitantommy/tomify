import type { Album } from '../types'

// Albums you used to play a lot but haven't played for a while, for Home.
export const FORGOTTEN_AFTER_DAYS = 182
export const MIN_PLAYS = 5
const DAY = 24 * 60 * 60 * 1000

// A different few each day from the same pool, so the section changes without jumping about on every visit.
function daySeed(now: Date) { return now.getFullYear() * 400 + now.getMonth() * 32 + now.getDate() }
function seeded(seed: number) {
  let value = seed % 2147483647 || 1
  return () => { value = (value * 16807) % 2147483647; return value / 2147483647 }
}

export function forgottenAlbums(albums: Album[], now: Date, count = 8): Album[] {
  const cutoff = now.getTime() - FORGOTTEN_AFTER_DAYS * DAY
  const pool = albums
    .filter((album) => (album.playCount ?? 0) >= MIN_PLAYS && album.played && Date.parse(album.played) < cutoff)
    .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
    .slice(0, count * 5)
  const random = seeded(daySeed(now))
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[pool[index], pool[swap]] = [pool[swap], pool[index]]
  }
  return pool.slice(0, count)
}

export function lastPlayedLabel(played: string | undefined, locale?: string) {
  const time = played ? Date.parse(played) : NaN
  if (!Number.isFinite(time)) return undefined
  return `Last played ${new Date(time).toLocaleDateString(locale ?? 'en-GB', { month: 'short', year: 'numeric' })}`
}
