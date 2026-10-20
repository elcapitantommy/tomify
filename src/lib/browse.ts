import type { Album } from '../types'
import type { GenreCount } from './navidrome'

export interface Decade { start: number; albumCount: number }

// Decades the library has albums from, newest first. Albums with no year are left out.
export function decadesOf(albums: Pick<Album, 'year'>[]): Decade[] {
  const counts = new Map<number, number>()
  for (const album of albums) {
    if (!album.year || album.year < 1900 || album.year > 2100) continue
    const start = Math.floor(album.year / 10) * 10
    counts.set(start, (counts.get(start) ?? 0) + 1)
  }
  return [...counts].map(([start, albumCount]) => ({ start, albumCount })).sort((a, b) => b.start - a.start)
}

export function decadeLabel(start: number) { return `${start}s` }

export function parseDecade(value: string | undefined) {
  const start = Number(value)
  return Number.isInteger(start) && start >= 1900 && start <= 2100 && start % 10 === 0 ? start : null
}

// Biggest genres first; a genre with no albums is just noise in a small library.
export function browseGenres(genres: GenreCount[]) {
  return genres.filter((genre) => genre.albumCount > 0).sort((a, b) => b.albumCount - a.albumCount || a.name.localeCompare(b.name))
}

// A steady colour per name so the tiles look the same on every visit.
const HUES = [88, 160, 200, 260, 320, 20, 45, 120]
export function tileHue(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return HUES[Math.abs(hash) % HUES.length]
}
