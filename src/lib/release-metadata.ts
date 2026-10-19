import type { Album, PartialDate } from '../types'

export type ReleaseType = 'album' | 'single' | 'ep' | 'compilation' | 'other'
export type ReleaseBucket = 'album' | 'single-ep' | 'compilation'
export type ReleaseFilter = 'all' | ReleaseBucket
export type ReleaseSort = 'newest' | 'oldest' | 'title' | 'added' | 'played'

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
  const original = (album.name || album.title || '').trim()
  let title = original
  let previous = ''
  while (title && title !== previous) {
    previous = title
    title = title
      .replace(/\s*[[(](?:[^\])]*(?:edition|version|remaster(?:ed)?|deluxe|expanded|anniversary|special|limited|japan(?:ese)?|australi(?:a|an)|uk|us|usa|european|cd\s*\d+|disc\s*\d+|single|e\.?p\.?|bonus|vinyl|digital|lossless|flac|hi[- ]?res|\d+\s*bit|\d+(?:\.\d+)?\s*k?hz)[^\])]*)[\])]\s*$/i, '')
      .replace(/\s*[[(](?:cd|disc)\s*\d+[\])]?\s*$/i, '')
      .trim()
  }
  return title || original
}

function releaseFamilyKind(album: Album, override?: ReleaseOverride): 'single-ep' | 'longform' {
  const type = resolvedReleaseType(album, override)
  return type === 'single' || type === 'ep' ? 'single-ep' : 'longform'
}

function releaseFamilyGroupingTitle(album: Album): string {
  const canonical = releaseFamilyTitle(album)
  const loose = canonical.replace(/\s*[[(][^\])]+[\])]\s*$/i, '').trim()
  return loose || canonical
}

export function releaseFamilyKey(album: Album, override?: ReleaseOverride): string {
  const kind = releaseFamilyKind(album, override)
  const artist = normaliseVariantText(album.artist || '')
  return `${artist}::${kind}::title:${normaliseVariantText(releaseFamilyGroupingTitle(album))}`
}

export interface ReleaseFamily {
  key: string
  representative: Album
  variants: Album[]
}

// Recently added and recently played go by the latest of a family's versions, so playing a deluxe edition lifts the family.
// Families never added or played (no timestamp) sort last, A–Z.
export function sortFamiliesByLatest(families: ReleaseFamily[], field: 'created' | 'played'): ReleaseFamily[] {
  const latest = (family: ReleaseFamily) => Math.max(0, ...family.variants.map((album) => Date.parse(album[field] ?? '') || 0))
  return families.map((family) => ({ family, at: latest(family) })).sort((a, b) => b.at - a.at || a.family.representative.name.localeCompare(b.family.representative.name, undefined, { sensitivity: 'base' })).map((item) => item.family)
}

export function collapseReleaseVariants(albums: Album[], overrides: Record<string, ReleaseOverride>): ReleaseFamily[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  for (const album of albums) parent.set(album.id, album.id)

  const titleOwner = new Map<string, string>()
  const mbidOwner = new Map<string, string>()

  for (const album of albums) {
    const override = overrides[album.id]
    const titleKey = releaseFamilyKey(album, override)
    const existingTitle = titleOwner.get(titleKey)
    if (existingTitle) union(album.id, existingTitle)
    else titleOwner.set(titleKey, album.id)

    if (override?.musicBrainzId) {
      const mbidKey = `${normaliseVariantText(album.artist || '')}::${releaseFamilyKind(album, override)}::${override.musicBrainzId}`
      const existingMbid = mbidOwner.get(mbidKey)
      if (existingMbid) union(album.id, existingMbid)
      else mbidOwner.set(mbidKey, album.id)
    }
  }

  const families = new Map<string, Album[]>()
  for (const album of albums) {
    const root = find(album.id)
    const family = families.get(root) ?? []
    family.push(album)
    families.set(root, family)
  }

  return [...families.values()].map((variants) => {
    const representative = [...variants].sort((a, b) => {
      const aBase = releaseFamilyTitle(a)
      const bBase = releaseFamilyTitle(b)
      const aExact = a.name.trim().toLocaleLowerCase('en') === aBase.toLocaleLowerCase('en') ? 0 : 1
      const bExact = b.name.trim().toLocaleLowerCase('en') === bBase.toLocaleLowerCase('en') ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      return a.name.length - b.name.length || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })[0]
    return {
      key: releaseFamilyKey(representative, overrides[representative.id]),
      representative,
      variants: [...variants].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }
  })
}
