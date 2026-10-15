export type RecoveryStatus = 'missing' | 'candidate-found' | 'importing' | 'queued' | 'downloading' | 'recovered' | 'needs-upgrade' | 'failed'

export const recoveryStatusLabels: Record<RecoveryStatus, string> = {
  missing: 'Missing',
  'candidate-found': 'Review candidate',
  importing: 'Importing',
  queued: 'Queued',
  downloading: 'Downloading',
  recovered: 'Recovered',
  'needs-upgrade': 'Needs upgrade',
  failed: 'Failed',
}

export type RecoveryBackend = 'youtube' | 'internet-archive' | 'usenet'
export type RecoverySearchMode = 'artist' | 'track' | 'release'

export interface AudioQuality {
  codec?: string | null
  container?: string | null
  bitrate?: number | null
  sampleRate?: number | null
  channels?: number | null
  duration?: number | null
}

export interface RecoveryProvenance {
  source?: string
  acquisitionMode?: 'anonymous-youtube' | 'authenticated-youtube-session'
  authenticatedAccessUsed?: boolean
  selectedFormatId?: string
  archiveStatus?: string
  licenseUrl?: string | null
  rights?: string | null
  raw?: { licenseUrl?: string | null; rights?: string | null; fileFormat?: string | null; fileSource?: string | null; [key: string]: unknown } | null
  sourceAudio?: { path?: string; extension?: string; quality?: AudioQuality; preservedOriginal?: boolean }
  derivative?: { path?: string; extension?: string; containerRemuxed?: boolean; createdByTomify?: boolean; operation?: string; audioStreamCopied?: boolean; transcoded?: boolean; quality?: AudioQuality }
  importedCount?: number
  importedTracks?: Array<{ path?: string | null; originalPath?: string | null; artist?: string | null; albumArtist?: string | null; album?: string | null; title?: string | null; trackNumber?: number | null; discNumber?: number | null; quality?: AudioQuality | null }>
  importedRelease?: { artist?: string | null; album?: string | null } | null
  job?: { id: string; status: 'queued' | 'downloading' | 'completed' | 'failed'; progress: number; provider?: string; downloader?: string; message?: string | null; error?: string | null } | null
  [key: string]: unknown
}

export interface RecoveryMetadata {
  artist?: string | null
  albumArtist?: string | null
  title?: string | null
  album?: string | null
  releaseDate?: string | null
  trackNumber?: number | null
  discNumber?: number | null
  recordingId?: string | null
  releaseId?: string | null
  releaseGroupId?: string | null
  duration?: number | null
  isrc?: string | null
}

export interface RecoveryMetadataResolution {
  authority: 'musicbrainz'
  status: 'matched' | 'unconfirmed' | 'not-found' | 'unavailable'
  confidence: number
  strong: boolean
  ambiguous?: boolean
  metadata?: RecoveryMetadata | null
  candidateId: string
  resolvedAt: string
}

export interface RecoveryMetadataChoices {
  artist: boolean
  title: boolean
  album: boolean
  releaseDate: boolean
  trackNumbers: boolean
}

export type RecoveryArtworkProvider = 'apple' | 'spotify' | 'cover-art-archive' | 'youtube'

export interface RecoveryArtworkCandidate {
  id: string
  provider: RecoveryArtworkProvider
  providerLabel: string
  providerId: string
  url: string
  previewUrl: string
  width?: number | null
  height?: number | null
  confidence: number
  quality: 'high' | 'preferred' | 'fallback'
  square: boolean
  selectable: boolean
  unavailableReason?: string | null
  artist?: string | null
  album?: string | null
  releaseDate?: string | null
  storeUrl?: string | null
}

export interface RecoveryArtworkResolution {
  candidates: RecoveryArtworkCandidate[]
  selectedCandidateId?: string | null
  resolvedAt: string
  candidateId: string
  configurationKey?: string
  providers?: Record<string, { available: boolean; acquisitionEnabled?: boolean }>
}

export interface RecoveryCandidate extends AudioQuality {
  id: string
  backend: RecoveryBackend
  externalId: string
  url: string
  title: string
  channel: string
  channelId?: string | null
  official: boolean
  matchScore: number
  thumbnail?: string | null
  selected: boolean
  importedPath?: string | null
  provenance?: RecoveryProvenance | null
}

export interface RecoveryItem {
  id: string
  artist: string
  title: string
  album?: string | null
  duration?: number | null
  trackNumber?: number | null
  discNumber?: number | null
  musicBrainzId?: string | null
  metadataResolution?: RecoveryMetadataResolution | null
  artworkResolution?: RecoveryArtworkResolution | null
  catalogueSource?: { catalogueSource: string; spotifyTrackId?: string | null; spotifyPlaylistId?: string | null; spotifyPlaylistPosition?: number | null; spotifyISRC?: string | null } | null
  status: RecoveryStatus
  notes?: string | null
  error?: string | null
  createdAt: string
  updatedAt: string
  candidates: RecoveryCandidate[]
}

const noise = /\b(live|remix|karaoke|nightcore|sped up|slowed|cover|instrumental|reaction)\b/i
const official = /\b(official|topic|vevo|records|recordings|music)\b/i

export function normaliseTrackText(value: string): string {
  return value.toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

function tokenScore(expected: string, actual: string): number {
  const wanted = new Set(normaliseTrackText(expected).split(' ').filter(Boolean))
  const found = new Set(normaliseTrackText(actual).split(' ').filter(Boolean))
  if (!wanted.size) return 0
  let matches = 0
  wanted.forEach((token) => { if (found.has(token)) matches += 1 })
  return matches / wanted.size
}

export function scoreRecoveryCandidate(
  wanted: Pick<RecoveryItem, 'artist' | 'title' | 'duration'>,
  candidate: Pick<RecoveryCandidate, 'title' | 'channel' | 'duration'>,
): { score: number; official: boolean } {
  const title = tokenScore(wanted.title, candidate.title)
  const artist = Math.max(tokenScore(wanted.artist, candidate.title), tokenScore(wanted.artist, candidate.channel))
  const durationDifference = wanted.duration && candidate.duration ? Math.abs(wanted.duration - candidate.duration) : null
  const duration = durationDifference === null ? 0.5 : durationDifference <= 2 ? 1 : durationDifference <= 5 ? 0.8 : durationDifference <= 12 ? 0.35 : 0
  const looksOfficial = official.test(candidate.channel) || official.test(candidate.title)
  const penalty = noise.test(candidate.title) && !noise.test(wanted.title) ? 24 : 0
  const score = Math.max(0, Math.min(100, Math.round(title * 48 + artist * 28 + duration * 18 + (looksOfficial ? 6 : 0) - penalty)))
  return { score, official: looksOfficial }
}

export function qualityLabel(candidate: AudioQuality): string {
  const values = [candidate.codec?.toUpperCase(), candidate.bitrate ? `${Math.round(candidate.bitrate / 1000)} kbps` : null, candidate.sampleRate ? `${(candidate.sampleRate / 1000).toFixed(1)} kHz` : null, candidate.channels ? `${candidate.channels} ch` : null]
  return values.filter(Boolean).join(' · ') || 'Quality measured after import'
}
