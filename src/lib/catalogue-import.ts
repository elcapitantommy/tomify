import type { Track } from '../types'

export type CatalogueItemStatus = 'unmatched' | 'available' | 'review' | 'missing' | 'unavailable'
export interface CatalogueArtwork { url: string; width?: number | null; height?: number | null }
export interface CatalogueMatch { track: Track; confidence: number }
export interface CataloguePlaylistItem {
  id?: string; position: number; status: CatalogueItemStatus; unavailableReason?: string | null
  providerTrackId?: string | null; providerAlbumId?: string | null; providerArtistIds?: string[]
  title: string; artists: string[]; album?: string | null; albumType?: string | null; duration?: number | null
  discNumber?: number | null; trackNumber?: number | null; releaseDate?: string | null; isrc?: string | null
  musicBrainzRecordingId?: string | null
  explicit?: boolean; artwork?: CatalogueArtwork[]; sourceUrl?: string | null
  localTrack?: Track | null; localTrackId?: string | null; recoveryId?: string | null; matchConfidence?: number; userConfirmed?: boolean
  matchCandidates?: CatalogueMatch[]
}
export interface CataloguePlaylistDraft { provider: 'spotify'; providerPlaylistId: string; name: string; description?: string | null; sourceUrl: string; snapshotId?: string | null; artwork: CatalogueArtwork[]; items: CataloguePlaylistItem[] }
export interface CataloguePlaylistSummary { id: string; name: string; provider: string; providerPlaylistId: string; sourceUrl: string; snapshotId?: string | null; artworkUrl?: string | null; createdAt: string; updatedAt: string; counts: { total: number; available: number; missing: number; review: number; unavailable: number }; provenance?: { autoRecovery?: boolean } | null }
export interface CataloguePlaylist extends CataloguePlaylistSummary { items: CataloguePlaylistItem[]; owner?: string; sharedWithMe?: boolean }
export interface CataloguePlaylistDiff { added: string[]; removed: string[]; reordered: boolean }

import { findCatalogueMatch } from './catalogue-match.mjs'

export { catalogueSearchQueries, findCatalogueMatch, matchCatalogueItem, stripEditionSuffix } from './catalogue-match.mjs'

export type CatalogueResolution = { id: string; localTrack: Track; matchConfidence: number; userConfirmed?: boolean } | { id: string; missing: true }
interface CatalogueLibrary { song(id: string): Promise<Track>; search(query: string): Promise<{ tracks: Track[] }> }

// Subsonic error 70 is "data not found"; anything else (offline, server error) leaves the entry alone.
function isNotFound(error: unknown) { const code = (error as { code?: number } | null)?.code; return code === 70 || code === 404 }

// Re-searches pending entries and re-checks `available` ones by Navidrome ID, which changes when files move.
// Returns only the entries whose stored state should change.
export async function revalidateCatalogueItems(items: CataloguePlaylistItem[], library: CatalogueLibrary, batchSize = 5): Promise<CatalogueResolution[]> {
  const search = async (query: string) => (await library.search(query)).tracks
  const resolutions: CatalogueResolution[] = []
  const checks = items.filter((item) => item.id && (item.status === 'missing' || item.status === 'review' || item.status === 'available'))
  for (let offset = 0; offset < checks.length; offset += batchSize) {
    const batch = await Promise.all(checks.slice(offset, offset + batchSize).map(async (item): Promise<CatalogueResolution | null> => {
      try {
        const stale = item.status === 'available'
        if (stale) {
          const localId = item.localTrackId || item.localTrack?.id
          if (!localId) return null
          try { await library.song(localId); return null } catch (error) { if (!isNotFound(error)) return null }
        }
        const matched = await findCatalogueMatch(item, search)
        if (matched.status === 'available' && matched.localTrack) return { id: item.id!, localTrack: matched.localTrack, matchConfidence: matched.matchConfidence || 0 }
        return stale ? { id: item.id!, missing: true } : null
      } catch { return null }
    }))
    resolutions.push(...batch.filter((value): value is CatalogueResolution => Boolean(value)))
  }
  return resolutions
}
