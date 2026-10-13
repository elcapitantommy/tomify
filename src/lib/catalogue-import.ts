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
export interface CataloguePlaylistSummary { id: string; name: string; provider: string; providerPlaylistId: string; sourceUrl: string; snapshotId?: string | null; artworkUrl?: string | null; createdAt: string; updatedAt: string; counts: { total: number; available: number; missing: number; review: number; unavailable: number } }
export interface CataloguePlaylist extends CataloguePlaylistSummary { items: CataloguePlaylistItem[] }
export interface CataloguePlaylistDiff { added: string[]; removed: string[]; reordered: boolean }

function normalise(value?: string | null) { return String(value || '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim() }
function similarity(expected?: string | null, actual?: string | null) { const left = new Set(normalise(expected).split(' ').filter(Boolean)); const right = new Set(normalise(actual).split(' ').filter(Boolean)); if (!left.size || !right.size) return 0; let common = 0; left.forEach((token) => { if (right.has(token)) common += 1 }); return 2 * common / (left.size + right.size) }
function versions(value?: string | null) { const text = normalise(value); return ['live', 'remix', 'acoustic', 'radio edit', 'karaoke', 'cover', 'sped up', 'slowed', 'instrumental'].filter((signal) => text.includes(signal)) }
function score(wanted: CataloguePlaylistItem, candidate: Track) {
  if (wanted.musicBrainzRecordingId && candidate.musicBrainzId && normalise(wanted.musicBrainzRecordingId) === normalise(candidate.musicBrainzId)) return 100
  if (wanted.isrc && candidate.isrc && normalise(wanted.isrc) === normalise(candidate.isrc)) return 99
  const wantedVersions = versions(wanted.title); const foundVersions = versions(candidate.title)
  if (wantedVersions.some((value) => !foundVersions.includes(value)) || foundVersions.some((value) => !wantedVersions.includes(value))) return 0
  const title = similarity(wanted.title, candidate.title); const artist = similarity(wanted.artists.join(' '), candidate.artist); const album = wanted.album ? similarity(wanted.album, candidate.album) : .5
  const difference = wanted.duration && candidate.duration ? Math.abs(wanted.duration - candidate.duration) : null; const duration = difference == null ? .5 : difference <= 2 ? 1 : difference <= 5 ? .8 : difference <= 10 ? .35 : 0
  if (title < .65 || artist < .65) return Math.round((title * .55 + artist * .35 + duration * .1) * 70)
  return Math.round(Math.min(98, title * 43 + artist * 35 + album * 12 + duration * 10))
}

export function matchCatalogueItem(item: CataloguePlaylistItem, candidates: Track[]): CataloguePlaylistItem {
  if (item.status === 'unavailable') return item
  const ranked = candidates.map((track) => ({ track, confidence: score(item, track) })).filter((entry) => entry.confidence > 0).sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  const best = ranked[0]; const ambiguous = Boolean(ranked[1] && ranked[1].confidence >= 72 && best && best.confidence - ranked[1].confidence <= 4)
  if (!best || best.confidence < 72) return { ...item, status: 'missing', localTrack: null, matchConfidence: best?.confidence || 0, matchCandidates: ranked }
  if (best.confidence < 92 || ambiguous) return { ...item, status: 'review', localTrack: null, matchConfidence: best.confidence, matchCandidates: ranked }
  return { ...item, status: 'available', localTrack: best.track, localTrackId: best.track.id, matchConfidence: best.confidence, matchCandidates: ranked }
}
