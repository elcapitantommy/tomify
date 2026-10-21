import type { Album, PartialDate } from '../types'
import type { ReleaseOverride } from './release-metadata'

export interface Anniversary { album: Album; year: number; years: number }

function parts(value?: PartialDate | null) {
  if (!value) return null
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null
  }
  return value.year && value.month && value.day ? { year: Number(value.year), month: Number(value.month), day: Number(value.day) } : null
}

// The album's first release date when known to the day: Tomify's own correction, then the original release, then this release.
export function fullReleaseDate(album: Album, override?: ReleaseOverride) {
  return parts(override?.releaseDate) ?? parts(album.originalReleaseDate) ?? parts(album.releaseDate)
}

// Albums released on today's date in an earlier year, the roundest anniversaries first, one per title and artist.
export function anniversaries(albums: Album[], today: Date, overrides: Record<string, ReleaseOverride> = {}): Anniversary[] {
  const seen = new Set<string>()
  const found: Anniversary[] = []
  for (const album of albums) {
    const date = fullReleaseDate(album, overrides[album.id])
    if (!date || date.month !== today.getMonth() + 1 || date.day !== today.getDate() || date.year >= today.getFullYear()) continue
    const key = `${album.artist}|${album.name}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ album, year: date.year, years: today.getFullYear() - date.year })
  }
  const roundness = (years: number) => years % 25 === 0 ? 3 : years % 10 === 0 ? 2 : years % 5 === 0 ? 1 : 0
  return found.sort((a, b) => roundness(b.years) - roundness(a.years) || b.years - a.years)
}

export const anniversaryLabel = (years: number) => years === 1 ? '1 year ago today' : `${years} years ago today`

// The whole local day one year back (or `yearsBack`), for the listening stats API.
export function dayLastYear(today: Date, yearsBack = 1) {
  const from = new Date(today.getFullYear() - yearsBack, today.getMonth(), today.getDate())
  const to = new Date(today.getFullYear() - yearsBack, today.getMonth(), today.getDate() + 1)
  return { from: from.getTime(), to: to.getTime() }
}

export const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
