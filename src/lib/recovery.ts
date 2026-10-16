import { classifyQuality, qualityTierDescription } from '../../shared/quality.mjs'

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

export type RecoveryBackend = 'youtube' | 'internet-archive' | 'usenet' | 'torrent'
export type RecoverySearchMode = 'artist' | 'track' | 'release'
export type RecoverySearchField = 'artist' | 'album' | 'track'
export const recoverySearchFields: RecoverySearchField[] = ['artist', 'album', 'track']

export function recoveryFieldValue(item: Pick<RecoveryItem, 'artist' | 'title' | 'album'>, field: RecoverySearchField) {
  return (field === 'artist' ? item.artist : field === 'album' ? item.album : item.title)?.trim() ?? ''
}

/** Artist-only Usenet searches import one matching track, so a wanted item without a title must include the album. */
export function recoverySearchFieldsReady(item: Pick<RecoveryItem, 'artist' | 'title' | 'album'>, fields: RecoverySearchField[]) {
  return fields.length > 0 && fields.every((field) => recoveryFieldValue(item, field))
}

/** Default Usenet search: artist plus the track title, or artist plus album when no title was entered. */
export function defaultRecoverySearchFields(item: Pick<RecoveryItem, 'artist' | 'title' | 'album'>): RecoverySearchField[] {
  const preferred: RecoverySearchField[] = recoveryFieldValue(item, 'track') ? ['artist', 'track'] : ['artist', 'album']
  const available = preferred.filter((field) => recoveryFieldValue(item, field))
  return available.length ? available : recoverySearchFields.filter((field) => recoveryFieldValue(item, field))
}

/** A pasted link the agent can hand to qBittorrent: a magnet link or an http(s) link to a .torrent file. */
export function looksLikeTorrentLink(value: string) {
  const link = value.trim()
  return /^magnet:\?.*xt=urn:btih:/i.test(link) || /^https?:\/\/\S+$/i.test(link)
}

/** The heading for a wanted item, which may be a track, a whole album, or just an artist. */
export function recoveryItemHeading(item: Pick<RecoveryItem, 'artist' | 'title' | 'album'>) {
  return item.title?.trim() || item.album?.trim() || item.artist?.trim() || 'Untitled'
}

/** Whatever the heading leaves out: artist and album under a track, artist under an album. */
export function recoveryItemSubtitle(item: Pick<RecoveryItem, 'artist' | 'title' | 'album'>) {
  const [artist, title, album] = [item.artist?.trim(), item.title?.trim(), item.album?.trim()]
  if (title) return [artist, album].filter(Boolean).join(' · ')
  if (album) return artist ? `${artist} · whole album` : 'Whole album'
  return 'Any music by this artist'
}

export interface AudioQuality {
  codec?: string | null
  container?: string | null
  bitrate?: number | null
  sampleRate?: number | null
  channels?: number | null
  duration?: number | null
}

/** Live figures qBittorrent reports for a torrent download. */
export interface TorrentTransferDetails {
  downloadSpeed?: number | null
  uploadSpeed?: number | null
  seeds?: number | null
  seedsInSwarm?: number | null
  peers?: number | null
  peersInSwarm?: number | null
  eta?: number | null
  size?: number | null
  downloaded?: number | null
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1 }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatEta(seconds: number) {
  if (seconds < 60) return `${seconds}s left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ${minutes % 60} min left` : `${Math.round(hours / 24)} days left`
}

/** One line of live torrent figures, e.g. "2.4 MB/s · 12 seeds (40) · 3 peers · 412 MB of 1.1 GB · 4 min left". */
export function torrentTransferSummary(details: TorrentTransferDetails | null | undefined) {
  if (!details) return null
  const count = (connected: number | null | undefined, swarm: number | null | undefined, label: string) => connected == null ? null : `${connected} ${label}${connected === 1 ? '' : 's'}${swarm != null && swarm > connected ? ` (${swarm})` : ''}`
  const parts = [
    details.downloadSpeed != null ? `${formatBytes(details.downloadSpeed)}/s` : null,
    count(details.seeds, details.seedsInSwarm, 'seed'),
    count(details.peers, details.peersInSwarm, 'peer'),
    details.size ? `${formatBytes(details.downloaded ?? 0)} of ${formatBytes(details.size)}` : null,
    details.eta != null ? formatEta(details.eta) : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** True for a torrent candidate found by qBittorrent's search plugins rather than a pasted link. */
export function isTorrentSearchResult(candidate: { backend: string; provenance?: RecoveryProvenance | null }) {
  return candidate.backend === 'torrent' && candidate.provenance?.raw?.providerId === 'qbittorrent-search'
}

/** Swarm and size figures for a torrent search result, e.g. "42 seeds · 3 peers · 512 MB". */
export function torrentResultSummary(raw: Record<string, unknown> | null | undefined) {
  if (!raw) return null
  const whole = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  const seeds = whole(raw.seeds)
  const peers = whole(raw.peers)
  const size = whole(raw.size)
  const parts = [
    seeds != null ? `${seeds} seed${seeds === 1 ? '' : 's'}` : null,
    peers != null ? `${peers} peer${peers === 1 ? '' : 's'}` : null,
    size ? formatBytes(size) : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
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
  remainingImportedAt?: string | null
  searchMode?: RecoverySearchMode
  job?: { id: string; status: 'queued' | 'downloading' | 'importing' | 'completed' | 'failed' | 'cancelled'; progress: number; provider?: string; downloader?: string; message?: string | null; error?: string | null; details?: TorrentTransferDetails | null } | null
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

/** Measured figures plus the quality tier, e.g. "MP3 · 243 kbps · 44.1 kHz · 2 ch · Transparent: lossy, but sounds the same as lossless". */
export function qualityLabel(candidate: AudioQuality): string {
  const values = [candidate.codec?.toUpperCase(), candidate.bitrate ? `${Math.round(candidate.bitrate / 1000)} kbps` : null, candidate.sampleRate ? `${(candidate.sampleRate / 1000).toFixed(1)} kHz` : null, candidate.channels ? `${candidate.channels} ch` : null]
  const measured = values.filter(Boolean).join(' · ')
  if (!measured) return 'Quality measured after import'
  return `${measured} · ${qualityTierDescription(classifyQuality(candidate).tier)}`
}

/** A Usenet import that took one track from a download that may hold more, e.g. a whole album. */
export function canImportRestOfDownload(candidate: RecoveryCandidate) {
  const provenance = candidate.provenance
  return candidate.backend === 'usenet' && candidate.selected && Boolean(candidate.importedPath) && Boolean(provenance?.job?.id)
    && provenance?.searchMode !== 'release' && !provenance?.remainingImportedAt && Number(provenance?.importedCount || 1) <= 1
}
