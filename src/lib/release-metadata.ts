import type { Album, PartialDate } from '../types'

export type ReleaseType = 'album' | 'single' | 'ep' | 'compilation' | 'other'
export type ReleaseBucket = 'album' | 'single-ep' | 'compilation'
export type ReleaseFilter = 'all' | ReleaseBucket
export type ReleaseSort = 'newest' | 'oldest' | 'title'

export interface ReleaseOverride {
  releaseType?: ReleaseType
  releaseDate?: string | null
  updatedAt?: string
  source?: 'manual' | 'musicbrainz'
  musicBrainzId?: string | null
  matchScore?: number | null
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

export function releaseTitleHint(album: Album): ReleaseType | undefined {
  const title = (album.name || album.title || '').trim()
  if (!title) return undefined
  if (/\((?:cd|disc)?\s*\d*\s*single(?:\s*version)?\)\s*$/i.test(title) || /\b(?:cd|disc)?\s*\d*\s*single\b/i.test(title)) return 'single'
  if (/\((?:cd|disc)?\s*\d*\s*e\.?p\.?\)\s*$/i.test(title) || /\be\.?p\.?\b/i.test(title)) return 'ep'
  if (/\(compilation\)\s*$/i.test(title)) return 'compilation'
  return undefined
}

export function inferReleaseType(album: Album): ReleaseType {
  const releaseTypes = (album.releaseTypes ?? []).map((value) => value.toLowerCase())
  if (album.isCompilation || releaseTypes.some((value) => value.includes('compilation'))) return 'compilation'
  if (releaseTypes.some((value) => value === 'ep' || value.includes('extended play'))) return 'ep'
  if (releaseTypes.some((value) => value.includes('single'))) return 'single'
  if (releaseTypes.some((value) => value.includes('album'))) return 'album'

  return releaseTitleHint(album) ?? 'album'
}

export function resolvedReleaseType(album: Album, override?: ReleaseOverride): ReleaseType {
  if (override?.source === 'manual' && override.releaseType) return override.releaseType
  const titleHint = releaseTitleHint(album)
  if (titleHint && (!override?.releaseType || override.releaseType === 'album' || override.releaseType === 'other')) return titleHint
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


function normaliseVariantText(value: string) {
  return value.toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function releaseFamilyTitle(album: Album): string {
  let title = (album.name || album.title || '').trim()
  title = title.replace(/\s*\((?:[^)]*(?:edition|version|remaster(?:ed)?|deluxe|expanded|anniversary|japan(?:ese)?|australi(?:a|an)|uk|us|european|cd\s*\d+|disc\s*\d+|single|e\.?p\.?)\s*[^)]*)\)\s*$/i, '')
  title = title.replace(/\s*[\[(](?:cd|disc)\s*\d+[\])]?\s*$/i, '')
  return title.trim() || (album.name || album.title || '').trim()
}

export function releaseFamilyKey(album: Album, override?: ReleaseOverride): string {
  const type = releaseBucket(resolvedReleaseType(album, override))
  const artist = normaliseVariantText(album.artist || '')
  if (override?.musicBrainzId) return `${artist}::${type}::mb:${override.musicBrainzId}`
  return `${artist}::${type}::title:${normaliseVariantText(releaseFamilyTitle(album))}`
}

export interface ReleaseFamily {
  key: string
  representative: Album
  variants: Album[]
}

export function collapseReleaseVariants(albums: Album[], overrides: Record<string, ReleaseOverride>): ReleaseFamily[] {
  const families = new Map<string, Album[]>()
  for (const album of albums) {
    const key = releaseFamilyKey(album, overrides[album.id])
    const family = families.get(key) ?? []
    family.push(album)
    families.set(key, family)
  }

  return [...families.entries()].map(([key, variants]) => {
    const representative = [...variants].sort((a, b) => {
      const aBase = releaseFamilyTitle(a)
      const bBase = releaseFamilyTitle(b)
      const aExact = a.name.trim().toLocaleLowerCase('en') === aBase.toLocaleLowerCase('en') ? 0 : 1
      const bExact = b.name.trim().toLocaleLowerCase('en') === bBase.toLocaleLowerCase('en') ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      return a.name.length - b.name.length || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })[0]
    return { key, representative, variants: [...variants].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) }
  })
}


export interface ReleaseVariantGroup {
  key: string
  title: string
  representative: Album
  variants: Album[]
}

const editionSuffixPattern = /\s*[\[(](?:[^\])]*(?:edition|version|remaster(?:ed)?|anniversary|deluxe|expanded|special|limited|japan(?:ese)?|uk|us|usa|australia|europe|cd\s*\d*|disc\s*\d*|vinyl|digital|hi[- ]?res|\d+\s*bit|\d+(?:\.\d+)?\s*k?hz|bonus)[^\])]*)[\])]\s*$/i

export function canonicalReleaseTitle(album: Album): string {
  let title = (album.name || album.title || '').trim()
  let previous = ''
  while (title && title !== previous) {
    previous = title
    title = title.replace(editionSuffixPattern, '').trim()
  }
  return title || (album.name || album.title || '').trim()
}

function normaliseGroupValue(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function releaseVariantGroupKey(album: Album, override?: ReleaseOverride): string {
  const bucket = releaseBucket(resolvedReleaseType(album, override))
  if (override?.musicBrainzId) return `${bucket}:mb:${override.musicBrainzId}`
  return `${bucket}:title:${normaliseGroupValue(album.artist)}:${normaliseGroupValue(canonicalReleaseTitle(album))}`
}

export function groupReleaseVariants(albums: Album[], overrides: Record<string, ReleaseOverride>): ReleaseVariantGroup[] {
  const groups = new Map<string, Album[]>()
  for (const album of albums) {
    const key = releaseVariantGroupKey(album, overrides[album.id])
    const items = groups.get(key) ?? []
    items.push(album)
    groups.set(key, items)
  }

  return [...groups.entries()].map(([key, variants]) => {
    const sorted = [...variants].sort((a, b) => {
      const canonicalA = canonicalReleaseTitle(a)
      const canonicalB = canonicalReleaseTitle(b)
      const exactA = a.name.trim().toLocaleLowerCase('en') === canonicalA.toLocaleLowerCase('en') ? 0 : 1
      const exactB = b.name.trim().toLocaleLowerCase('en') === canonicalB.toLocaleLowerCase('en') ? 0 : 1
      if (exactA !== exactB) return exactA - exactB
      if ((a.year ?? 0) !== (b.year ?? 0)) return (a.year ?? 0) - (b.year ?? 0)
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { key, title: canonicalReleaseTitle(sorted[0]), representative: sorted[0], variants: sorted }
  })
}
