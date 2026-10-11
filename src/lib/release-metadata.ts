import type { Album, PartialDate } from '../types'

export type ReleaseType = 'album' | 'single' | 'ep' | 'compilation' | 'other'
export type ReleaseBucket = 'album' | 'single-ep' | 'compilation'
export type ReleaseFilter = 'all' | ReleaseBucket
export type ReleaseSort = 'newest' | 'oldest' | 'title'

export interface ReleaseOverride {
  releaseType?: ReleaseType
  releaseDate?: string | null
  updatedAt?: string
}

interface DateParts { year: number; month?: number; day?: number }

export const releaseTypeLabels: Record<ReleaseType, string> = {
  album: 'Album',
  single: 'Single',
  ep: 'EP',
  compilation: 'Compilation',
  other: 'Other',
}

function parsePartialDate(value?: PartialDate | null): DateParts | undefined {
  if (!value) return undefined
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/)
    if (!match) return undefined
    return { year: Number(match[1]), month: match[2] ? Number(match[2]) : undefined, day: match[3] ? Number(match[3]) : undefined }
  }
  if (!value.year) return undefined
  return { year: Number(value.year), month: value.month ? Number(value.month) : undefined, day: value.day ? Number(value.day) : undefined }
}

export function inferReleaseType(album: Album): ReleaseType {
  const releaseTypes = (album.releaseTypes ?? []).map((value) => value.toLowerCase())
  if (album.isCompilation || releaseTypes.some((value) => value.includes('compilation'))) return 'compilation'
  if (releaseTypes.some((value) => value === 'ep' || value.includes('extended play'))) return 'ep'
  if (releaseTypes.some((value) => value.includes('single'))) return 'single'
  if (releaseTypes.some((value) => value.includes('album'))) return 'album'

  const title = album.name || album.title || ''
  if (/\((?:single|single version)\)\s*$/i.test(title)) return 'single'
  if (/\(ep\)\s*$/i.test(title)) return 'ep'
  if (/\(compilation\)\s*$/i.test(title)) return 'compilation'
  return 'album'
}

export function resolvedReleaseType(album: Album, override?: ReleaseOverride): ReleaseType {
  return override?.releaseType ?? inferReleaseType(album)
}

export function releaseBucket(type: ReleaseType): ReleaseBucket {
  if (type === 'single' || type === 'ep') return 'single-ep'
  if (type === 'compilation') return 'compilation'
  return 'album'
}

export function resolvedReleaseDateParts(album: Album, override?: ReleaseOverride): DateParts | undefined {
  const overrideDate = parsePartialDate(override?.releaseDate)
  if (overrideDate) return overrideDate
  return parsePartialDate(album.releaseDate) ?? parsePartialDate(album.originalReleaseDate) ?? (album.year ? { year: album.year } : undefined)
}

export function releaseDateSortValue(album: Album, override?: ReleaseOverride): number {
  const parts = resolvedReleaseDateParts(album, override)
  if (!parts) return 0
  return parts.year * 10000 + (parts.month ?? 0) * 100 + (parts.day ?? 0)
}

export function releaseYearLabel(album: Album, override?: ReleaseOverride): string | undefined {
  return resolvedReleaseDateParts(album, override)?.year.toString()
}

export function releaseDateLabel(album: Album, override?: ReleaseOverride): string | undefined {
  const parts = resolvedReleaseDateParts(album, override)
  if (!parts) return undefined
  if (!parts.month) return String(parts.year)
  if (!parts.day) return new Date(Date.UTC(parts.year, parts.month - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function releaseDateInputValue(album: Album, override?: ReleaseOverride): string {
  if (override?.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(override.releaseDate)) return override.releaseDate
  const parts = parsePartialDate(album.releaseDate) ?? parsePartialDate(album.originalReleaseDate)
  if (!parts?.month || !parts.day) return ''
  return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join('-')
}

export function sortReleases(albums: Album[], overrides: Record<string, ReleaseOverride>, sort: ReleaseSort): Album[] {
  return [...albums].sort((a, b) => {
    if (sort === 'title') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    const difference = releaseDateSortValue(a, overrides[a.id]) - releaseDateSortValue(b, overrides[b.id])
    if (difference !== 0) return sort === 'newest' ? -difference : difference
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}
