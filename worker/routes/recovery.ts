// @ts-nocheck -- TODO(Task 16 follow-up): type this legacy Worker module without changing its behaviour.
import { applyRecoveryMetadataChoices, metadataTextSimilarity, normaliseMetadataText, resolveRecoveryMetadata } from '../../scripts/recovery-metadata.mjs'
import { appleArtworkUrl, rankArtworkCandidates } from '../../scripts/recovery-artwork.mjs'
import { completenessText, isMusicBrainzId, releaseGroupTypeFit, resolveAlbumTracklist, selectTracklist } from '../features/completeness.ts'
import { recoveryImportStatus } from '../features/quality.ts'
import { markRecoveryScanPending, parseRecoveryPlayback } from '../features/library-scan.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { isNavidromeConfigurationError } from '../lib/navidrome.ts'
import { callRecoveryAgent, RecoveryAgentOutdated, recoveryAgentStatus } from '../lib/agent.ts'
import { TOMIFY_AGENT_CONTRACT } from '../generated/build-info.ts'

function recoveryCandidateRow(row) {
  let provenance = null
  try { provenance = row.provenanceJson ? JSON.parse(row.provenanceJson) : null } catch { provenance = null }
  return {
    id: row.id, backend: row.backend, externalId: row.externalId, url: row.url, title: row.title, channel: row.channel,
    channelId: row.channelId ?? null, duration: row.duration == null ? null : Number(row.duration), official: Boolean(row.official),
    matchScore: Number(row.matchScore || 0), thumbnail: row.thumbnail ?? null, codec: row.codec ?? null, container: row.container ?? null,
    bitrate: row.bitrate == null ? null : Number(row.bitrate), sampleRate: row.sampleRate == null ? null : Number(row.sampleRate), channels: row.channels == null ? null : Number(row.channels),
    importedPath: row.importedPath ?? null, provenance, selected: Boolean(row.selected),
  }
}

export async function recoveryItem(db, username, id) {
  const row = await db.prepare('SELECT id, artist, title, album, duration, track_number AS trackNumber, disc_number AS discNumber, musicbrainz_id AS musicBrainzId, metadata_resolution_json AS metadataResolutionJson, artwork_resolution_json AS artworkResolutionJson, source_json AS sourceJson, playback_json AS playbackJson, status, notes, error, created_at AS createdAt, updated_at AS updatedAt FROM recovery_items WHERE username = ? AND id = ?').bind(username, id).first()
  if (!row) return null
  const candidates = await db.prepare('SELECT id, backend, external_id AS externalId, url, title, channel, channel_id AS channelId, duration, official, match_score AS matchScore, thumbnail, codec, container, bitrate, sample_rate AS sampleRate, channels, imported_path AS importedPath, provenance_json AS provenanceJson, selected FROM recovery_candidates WHERE recovery_id = ? ORDER BY selected DESC, match_score DESC, created_at DESC').bind(id).all()
  let metadataResolution = null
  let artworkResolution = null
  let catalogueSource = null
  try { metadataResolution = row.metadataResolutionJson ? JSON.parse(row.metadataResolutionJson) : null } catch { metadataResolution = null }
  try { artworkResolution = row.artworkResolutionJson ? JSON.parse(row.artworkResolutionJson) : null } catch { artworkResolution = null }
  try { catalogueSource = row.sourceJson ? JSON.parse(row.sourceJson) : null } catch { catalogueSource = null }
  const item = { ...row }
  delete item.metadataResolutionJson
  delete item.artworkResolutionJson
  delete item.sourceJson
  delete item.playbackJson
  return { ...item, metadataResolution, artworkResolution, catalogueSource, playback: parseRecoveryPlayback(row.playbackJson), duration: row.duration == null ? null : Number(row.duration), trackNumber: row.trackNumber == null ? null : Number(row.trackNumber), discNumber: row.discNumber == null ? null : Number(row.discNumber), candidates: (candidates.results || []).map(recoveryCandidateRow) }
}

function isReleaseRecoveryCandidate(candidate) {
  return (candidate?.backend === 'usenet' || candidate?.backend === 'torrent') && (candidate?.provenance?.searchMode === 'release' || candidate?.provenance?.raw?.searchMode === 'release')
}

async function recoveryReleaseTracklist(db, item, candidate, resolvedMetadata, username) {
  if (!isReleaseRecoveryCandidate(candidate)) return null
  const source = item.catalogueSource || {}
  const albumId = typeof source.albumId === 'string' && source.albumId ? source.albumId : 'recovery:' + item.id
  const requestedReleaseId = [source.releaseId, resolvedMetadata?.releaseId, item.metadataResolution?.metadata?.releaseId].find(isMusicBrainzId) || null
  let cached = await selectTracklist(db, albumId)
  if (!cached || (requestedReleaseId && cached.tracklist?.releaseId !== requestedReleaseId)) {
    const resolved = await resolveAlbumTracklist(db, { albumId, name: resolvedMetadata?.album || item.album || '', artist: resolvedMetadata?.artist || item.artist || '', year: Number(String(resolvedMetadata?.releaseDate || source.releaseDate || '').slice(0, 4)) || null, musicBrainzId: requestedReleaseId, localTrackCount: 0 }, requestedReleaseId)
    if (!resolved) return null
    await db.prepare('INSERT INTO release_tracklists (album_id, release_id, release_group_id, source, tracklist_json, editions_json, fetched_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET release_id = excluded.release_id, release_group_id = excluded.release_group_id, source = excluded.source, tracklist_json = excluded.tracklist_json, editions_json = excluded.editions_json, fetched_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
      .bind(albumId, resolved.tracklist.releaseId, resolved.tracklist.releaseGroupId, resolved.tracklist.source, JSON.stringify(resolved.tracklist), JSON.stringify(resolved.editions), username).run()
    cached = resolved
  }
  return cached?.tracklist || null
}

function importedTrackMetadata(track, result) {
  const resolved = track?.provenance?.resolvedMetadata || {}
  return {
    path: track?.path || null, originalPath: track?.originalPath || null,
    artist: track?.artist || resolved.artist || null, albumArtist: track?.albumArtist || resolved.albumArtist || result?.artist || null,
    album: track?.album || resolved.album || result?.album || null, title: track?.title || resolved.title || null,
    trackNumber: track?.trackNumber || resolved.trackNumber || null, discNumber: track?.discNumber || resolved.discNumber || null,
    recordingId: resolved.recordingId || null, releaseId: resolved.releaseId || null, releaseGroupId: resolved.releaseGroupId || null, isrc: resolved.isrc || null,
    quality: track?.quality || null, derivative: track?.derivative || null, provenance: track?.provenance || null,
  }
}

async function linkReleaseImport(db, username, parentItem, parentCandidate, result) {
  const tracks = (Array.isArray(result?.importedTracks) ? result.importedTracks : []).map((track) => importedTrackMetadata(track, result)).filter((track) => track.path && track.title)
  if (!result?.completeness || !tracks.length) return
  const rows = await db.prepare('SELECT id, artist, title, album, musicbrainz_id AS musicBrainzId FROM recovery_items WHERE username = ?').bind(username).all()
  const recoveries = rows.results || []
  const linked = []
  for (const track of tracks) {
    const artist = track.artist || track.albumArtist || result.artist || 'Unknown Artist'
    const album = track.album || result.album || null
    const sameRelease = (row) => completenessText(row.artist) === completenessText(artist) && completenessText(row.album) === completenessText(album)
    let recovery = recoveries.find((row) => sameRelease(row) && track.recordingId && row.musicBrainzId === track.recordingId)
      || recoveries.find((row) => sameRelease(row) && completenessText(row.title) === completenessText(track.title))
    if (!recovery) {
      recovery = { id: crypto.randomUUID(), artist, title: track.title, album, musicBrainzId: track.recordingId }
      const source = { catalogueSource: 'musicbrainz', origin: 'release-import', parentRecoveryId: parentItem.id, releaseId: track.releaseId, releaseGroupId: track.releaseGroupId, recordingId: track.recordingId, isrc: track.isrc }
      await db.prepare('INSERT INTO recovery_items (id, username, artist, title, album, duration, track_number, disc_number, musicbrainz_id, source_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(recovery.id, username, String(artist).slice(0, 240), String(track.title).slice(0, 240), album ? String(album).slice(0, 240) : null, Number(track.quality?.duration) || null, Number(track.trackNumber) || null, Number(track.discNumber) || null, track.recordingId, JSON.stringify(source), recoveryImportStatus(track.quality)).run()
      recoveries.push(recovery)
    }
    const existing = await db.prepare('SELECT id FROM recovery_candidates WHERE recovery_id = ? AND imported_path = ?').bind(recovery.id, track.path).first()
    let candidateId = existing?.id || null
    if (!candidateId && recovery.id === parentItem.id) {
      candidateId = parentCandidate.id
      await db.prepare('UPDATE recovery_candidates SET codec = ?, container = ?, bitrate = ?, sample_rate = ?, channels = ?, duration = COALESCE(?, duration), imported_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(track.quality?.codec || null, track.quality?.container || null, Number.isFinite(track.quality?.bitrate) ? track.quality.bitrate : null, Number.isFinite(track.quality?.sampleRate) ? track.quality.sampleRate : null, Number.isFinite(track.quality?.channels) ? track.quality.channels : null, Number.isFinite(track.quality?.duration) ? track.quality.duration : null, track.path, candidateId).run()
    }
    if (!candidateId && recovery.id !== parentItem.id) {
      candidateId = crypto.randomUUID()
      const provenance = { ...(track.provenance || {}), source: track.provenance?.source || parentCandidate.backend, parentRecoveryId: parentItem.id, parentCandidateId: parentCandidate.id, completeness: result.completeness }
      await db.prepare('INSERT INTO recovery_candidates (id, recovery_id, backend, external_id, url, title, channel, duration, official, match_score, codec, container, bitrate, sample_rate, channels, imported_path, provenance_json, rights_basis, selected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 100, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .bind(candidateId, recovery.id, parentCandidate.backend, String(parentCandidate.externalId || parentCandidate.id) + ':' + String(track.discNumber || 1) + '-' + String(track.trackNumber || 0), parentCandidate.url, track.title, parentCandidate.channel, Number(track.quality?.duration) || null, track.quality?.codec || null, track.quality?.container || null, Number.isFinite(track.quality?.bitrate) ? track.quality.bitrate : null, Number.isFinite(track.quality?.sampleRate) ? track.quality.sampleRate : null, Number.isFinite(track.quality?.channels) ? track.quality.channels : null, track.path, JSON.stringify(provenance), parentCandidate.provenance?.rightsBasis || null).run()
    }
    await db.prepare('UPDATE recovery_items SET selected_candidate_id = COALESCE(?, selected_candidate_id), musicbrainz_id = COALESCE(musicbrainz_id, ?), track_number = COALESCE(track_number, ?), disc_number = COALESCE(disc_number, ?), status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(candidateId, track.recordingId, Number(track.trackNumber) || null, Number(track.discNumber) || null, recoveryImportStatus(track.quality), recovery.id, username).run()
    linked.push({ track, recoveryId: recovery.id })
  }

  const catalogueRows = await db.prepare("SELECT i.id, i.metadata_json AS metadataJson FROM catalogue_playlist_items i JOIN catalogue_playlists p ON p.id = i.playlist_id WHERE p.username = ? AND p.provider = 'spotify' AND i.status != 'unavailable'").bind(username).all()
  const statements = []
  for (const row of catalogueRows.results || []) {
    let metadata = null
    try { metadata = JSON.parse(row.metadataJson) } catch { continue }
    const match = linked.find(({ track }) => (track.isrc && metadata?.isrc && completenessText(track.isrc) === completenessText(metadata.isrc)) || (completenessText(track.title) === completenessText(metadata?.title) && completenessText(track.album) === completenessText(metadata?.album) && (Array.isArray(metadata?.artists) ? metadata.artists : []).some((artist) => completenessText(artist) === completenessText(track.artist || track.albumArtist))))
    if (match) statements.push(db.prepare("UPDATE catalogue_playlist_items SET status = 'missing', local_track_id = NULL, local_track_json = NULL, recovery_id = ?, match_confidence = 0, user_confirmed = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(match.recoveryId, row.id))
  }
  if (statements.length) await db.batch(statements)
}

function recoveryTokens(value) {
  return new Set(String(value || '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean))
}

function recoveryTokenScore(expected, actual) {
  const wanted = recoveryTokens(expected)
  const found = recoveryTokens(actual)
  if (!wanted.size) return 0
  let matches = 0
  for (const token of wanted) if (found.has(token)) matches += 1
  return matches / wanted.size
}

function scoreRecoveryCandidate(item, candidate) {
  const title = recoveryTokenScore(item.title || item.album, candidate.title)
  const artist = Math.max(recoveryTokenScore(item.artist, candidate.title), recoveryTokenScore(item.artist, candidate.channel))
  const difference = item.duration && candidate.duration ? Math.abs(Number(item.duration) - Number(candidate.duration)) : null
  const duration = difference == null ? 0.5 : difference <= 2 ? 1 : difference <= 5 ? 0.8 : difference <= 12 ? 0.35 : 0
  const combined = String(candidate.title || '') + ' ' + String(candidate.channel || '')
  const looksOfficial = ['official', 'topic', 'vevo', 'records', 'recordings'].some((word) => combined.toLocaleLowerCase('en').includes(word))
  const unwanted = [' live', 'remix', 'karaoke', 'nightcore', 'sped up', 'slowed', ' cover', 'instrumental'].some((word) => String(candidate.title || '').toLocaleLowerCase('en').includes(word)) && !String(item.title || '').toLocaleLowerCase('en').includes('live')
  return { official: looksOfficial, score: Math.max(0, Math.min(100, Math.round(title * 48 + artist * 28 + duration * 18 + (looksOfficial ? 6 : 0) - (unwanted ? 24 : 0)))) }
}

async function requireRecoveryAgentContract(env) {
  const status = await recoveryAgentStatus(env)
  if (!Number.isInteger(status?.contract) || status.contract < TOMIFY_AGENT_CONTRACT) throw new RecoveryAgentOutdated()
  return status
}

export function rowToItem(row) {
  if (!row) return null
  return {
    albumId: row.albumId,
    releaseType: row.releaseType,
    releaseDate: row.releaseDate ?? null,
    updatedAt: row.updatedAt,
    source: row.source || 'manual',
    musicBrainzId: row.musicBrainzId ?? null,
    matchScore: row.matchScore ?? null,
  }
}

function normalise(value) {
  return String(value || '').toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim()
}

function releaseTitleHint(title) {
  const value = String(title || '').trim()
  if (/\((?:cd|disc)?\s*\d*\s*single(?:\s*version)?\)\s*$/i.test(value) || /\b(?:cd|disc)?\s*\d*\s*single\b/i.test(value)) return 'single'
  if (/\((?:cd|disc)?\s*\d*\s*e\.?p\.?\)\s*$/i.test(value) || /\be\.?p\.?\b/i.test(value)) return 'ep'
  return null
}

export function cleanReleaseTitle(title) {
  return String(title || '').replace(/\s*\((?:cd|disc)?\s*\d*\s*(?:single(?:\s*version)?|e\.?p\.?)\)\s*$/i, '').trim()
}

export function musicBrainzType(group) {
  const secondary = (group['secondary-types'] || []).map((value) => String(value).toLowerCase())
  if (secondary.includes('compilation')) return 'compilation'
  const primary = String(group['primary-type'] || '').toLowerCase()
  if (primary === 'single') return 'single'
  if (primary === 'ep') return 'ep'
  if (primary === 'album') return 'album'
  return 'other'
}

function artistCredit(group) {
  return (group['artist-credit'] || []).map((credit) => credit?.name || credit?.artist?.name || '').filter(Boolean).join(' ')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let musicBrainzQueue = Promise.resolve()
let lastMusicBrainzRequestAt = 0

export async function musicBrainzJson(url) {
  const operation = musicBrainzQueue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt))
    if (wait) await sleep(wait)
    lastMusicBrainzRequestAt = Date.now()
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 (https://app.tomify.tomdixon.uk)' } })
    if (!response.ok) return null
    return response.json()
  })
  musicBrainzQueue = operation.catch(() => null)
  return operation
}

async function resolveMusicBrainzRecovery(item, candidateId) {
  const title = normaliseMetadataText(item.title)
  const artist = normaliseMetadataText(item.artist)
  const isrc = String(item.catalogueSource?.spotifyISRC || item.catalogueSource?.isrc || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (!title || !artist) return { authority: 'musicbrainz', status: 'not-found', confidence: 0, strong: false, metadata: null, candidateId, resolvedAt: new Date().toISOString() }
  const url = new URL('https://musicbrainz.org/ws/2/recording/')
  const recordingId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(item.musicBrainzId || '')) ? item.musicBrainzId : ''
  url.searchParams.set('query', recordingId ? 'rid:' + recordingId : isrc ? 'isrc:' + isrc : 'recording:(' + title + ') AND artist:(' + artist + ')')
  url.searchParams.set('limit', '15')
  url.searchParams.set('fmt', 'json')
  let result = await musicBrainzJson(url)
  if ((recordingId || isrc) && (!Array.isArray(result?.recordings) || !result.recordings.length)) {
    url.searchParams.set('query', 'recording:(' + title + ') AND artist:(' + artist + ')')
    result = await musicBrainzJson(url)
  }
  if (!result) return { authority: 'musicbrainz', status: 'unavailable', confidence: 0, strong: false, metadata: null, candidateId, resolvedAt: new Date().toISOString() }
  return { authority: 'musicbrainz', ...resolveRecoveryMetadata({ artist: item.artist, title: item.title, album: item.album, duration: item.duration || item.candidates.find((value) => value.id === candidateId)?.duration || null, isrc: isrc || null }, result.recordings), candidateId, resolvedAt: new Date().toISOString() }
}

export function artworkYearScore(expectedDate, actualDate) {
  const expected = String(expectedDate || '').slice(0, 4)
  const actual = String(actualDate || '').slice(0, 4)
  if (!expected || !actual) return 0.5
  const difference = Math.abs(Number(expected) - Number(actual))
  return difference === 0 ? 1 : difference === 1 ? 0.6 : 0
}

async function appleArtworkCandidates(env, metadata) {
  const url = new URL('https://itunes.apple.com/search')
  url.searchParams.set('term', [metadata.artist, metadata.album || metadata.title].filter(Boolean).join(' '))
  url.searchParams.set('media', 'music')
  url.searchParams.set('entity', metadata.album ? 'album' : 'song')
  url.searchParams.set('limit', '20')
  url.searchParams.set('country', String(env.APPLE_CATALOGUE_COUNTRY || 'GB').slice(0, 2).toUpperCase())
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) return []
  const body = await response.json()
  const enabled = String(env.APPLE_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true'
  const results = Array.isArray(body.results) ? body.results : []
  return results.map((result) => {
    const artistSimilarity = metadataTextSimilarity(metadata.artist, result.artistName)
    const albumSimilarity = metadata.album ? metadataTextSimilarity(metadata.album, result.collectionName) : 1
    const titleSimilarity = metadata.album ? 1 : metadataTextSimilarity(metadata.title, result.trackName)
    const confidence = Math.round((metadata.album ? artistSimilarity * 45 + albumSimilarity * 45 : artistSimilarity * 55 + titleSimilarity * 35) + artworkYearScore(metadata.releaseDate, result.releaseDate) * 10)
    if (artistSimilarity < 0.82 || (metadata.album && albumSimilarity < 0.72) || (!metadata.album && titleSimilarity < 0.78) || !result.artworkUrl100) return null
    const providerId = String(result.collectionId || result.trackId || '')
    return { id: 'apple:' + providerId, provider: 'apple', providerLabel: 'Apple catalogue', providerId, url: appleArtworkUrl(result.artworkUrl100, 1200), previewUrl: appleArtworkUrl(result.artworkUrl100, 300), width: 1200, height: 1200, confidence, artist: result.artistName || null, album: result.collectionName || null, releaseDate: result.releaseDate || null, storeUrl: result.collectionViewUrl || result.trackViewUrl || null, selectable: enabled, unavailableReason: enabled ? null : 'Apple artwork acquisition requires explicit server-side enablement after confirming applicable usage rights.' }
  }).filter(Boolean)
}

let spotifyTokenCache = null
export function resetSpotifyTokenCache() { spotifyTokenCache = null }
export async function spotifyAccessToken(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null
  if (spotifyTokenCache && spotifyTokenCache.expiresAt > Date.now() + 60_000) return spotifyTokenCache.token
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa(String(env.SPOTIFY_CLIENT_ID) + ':' + String(env.SPOTIFY_CLIENT_SECRET)), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!response.ok) return null
  const body = await response.json()
  if (!body.access_token) return null
  spotifyTokenCache = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 }
  return spotifyTokenCache.token
}

async function spotifyArtworkCandidates(env, metadata) {
  const token = await spotifyAccessToken(env)
  if (!token) return []
  const url = new URL('https://api.spotify.com/v1/search')
  url.searchParams.set('q', metadata.album ? 'album:' + metadata.album + ' artist:' + metadata.artist : 'track:' + metadata.title + ' artist:' + metadata.artist)
  url.searchParams.set('type', metadata.album ? 'album' : 'track')
  url.searchParams.set('limit', '10')
  url.searchParams.set('market', String(env.SPOTIFY_MARKET || 'GB').slice(0, 2).toUpperCase())
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
  if (!response.ok) return []
  const body = await response.json()
  const enabled = String(env.SPOTIFY_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true'
  const raw = metadata.album ? body.albums?.items : (body.tracks?.items || []).map((track) => track.album)
  return (Array.isArray(raw) ? raw : []).map((album) => {
    const artistName = (album.artists || []).map((artist) => artist.name).join(' ')
    const artistSimilarity = metadataTextSimilarity(metadata.artist, artistName)
    const albumSimilarity = metadata.album ? metadataTextSimilarity(metadata.album, album.name) : 1
    if (artistSimilarity < 0.82 || (metadata.album && albumSimilarity < 0.72)) return null
    const image = (album.images || []).slice().sort((left, right) => Number(right.width || 0) - Number(left.width || 0))[0]
    if (!image?.url) return null
    const confidence = Math.round(artistSimilarity * 50 + albumSimilarity * 40 + artworkYearScore(metadata.releaseDate, album.release_date) * 10)
    return { id: 'spotify:' + album.id, provider: 'spotify', providerLabel: 'Spotify', providerId: album.id, url: image.url, previewUrl: image.url, width: image.width || null, height: image.height || null, confidence, artist: artistName || null, album: album.name || null, releaseDate: album.release_date || null, storeUrl: album.external_urls?.spotify || null, selectable: enabled, unavailableReason: enabled ? null : 'Spotify artwork acquisition requires explicit server-side enablement after confirming applicable usage rights.' }
  }).filter(Boolean)
}

async function coverArtArchiveCandidates(metadata) {
  if (!metadata.releaseId) return []
  const response = await fetch('https://coverartarchive.org/release/' + encodeURIComponent(metadata.releaseId), { headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 (https://app.tomify.tomdixon.uk)' } })
  if (!response.ok) return []
  const body = await response.json()
  return (Array.isArray(body.images) ? body.images : []).filter((image) => image?.front === true || (image?.types || []).includes('Front')).slice(0, 4).map((image) => {
    const url = image.thumbnails?.['1200'] || image.thumbnails?.['500'] || image.image
    const size = image.thumbnails?.['1200'] ? 1200 : image.thumbnails?.['500'] ? 500 : null
    const physicalHint = /booklet|case|tray|disc|vinyl|spine|scan/i.test(String(image.comment || ''))
    return { id: 'cover-art-archive:' + image.id, provider: 'cover-art-archive', providerLabel: 'Cover Art Archive', providerId: String(image.id), url: String(url || '').replace(/^http:/, 'https:'), previewUrl: String(image.thumbnails?.['500'] || url || '').replace(/^http:/, 'https:'), width: size, height: size, confidence: Math.max(0, Number(metadata.matchConfidence || 85) - (physicalHint ? 25 : 0)), artist: metadata.artist || null, album: metadata.album || null, releaseDate: metadata.releaseDate || null, selectable: Boolean(url), unavailableReason: null, physicalMediaHint: physicalHint }
  })
}

function youtubeArtworkCandidates(sourceCandidate) {
  if (sourceCandidate?.backend !== 'youtube' || !sourceCandidate?.thumbnail) return []
  return [{ id: 'youtube:' + sourceCandidate.externalId, provider: 'youtube', providerLabel: 'YouTube thumbnail', providerId: sourceCandidate.externalId, url: sourceCandidate.thumbnail, previewUrl: sourceCandidate.thumbnail, width: null, height: null, confidence: Math.min(50, Number(sourceCandidate.matchScore || 0)), artist: null, album: null, releaseDate: null, selectable: true, unavailableReason: null }]
}

function catalogueArtworkCandidates(env, item) {
  if (item.catalogueSource?.catalogueSource !== 'spotify' || !Array.isArray(item.catalogueSource.artwork)) return []
  const image = item.catalogueSource.artwork.slice().sort((left, right) => Number(right.width || 0) - Number(left.width || 0))[0]
  if (!image?.url) return []
  const enabled = String(env.SPOTIFY_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true'
  return [{ id: 'spotify-track:' + item.catalogueSource.spotifyTrackId, provider: 'spotify', providerLabel: 'Spotify', providerId: item.catalogueSource.spotifyAlbumId || item.catalogueSource.spotifyTrackId, url: image.url, previewUrl: image.url, width: image.width || null, height: image.height || null, confidence: 100, artist: item.artist, album: item.album || null, releaseDate: item.catalogueSource.releaseDate || null, storeUrl: item.catalogueSource.spotifyTrackUrl || item.catalogueSource.sourcePlaylistUrl || null, selectable: enabled, unavailableReason: enabled ? null : 'Spotify artwork acquisition requires explicit server-side enablement after confirming applicable usage rights.' }]
}

function artworkConfigurationKey(env) {
  return [
    String(env.APPLE_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true',
    String(env.APPLE_CATALOGUE_COUNTRY || 'GB').toUpperCase(),
    Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
    String(env.SPOTIFY_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true',
    String(env.SPOTIFY_MARKET || 'GB').toUpperCase(),
  ].join(':')
}

async function resolveRecoveryArtwork(env, metadataResolution, item, sourceCandidate) {
  const matched = metadataResolution?.strong ? metadataResolution.metadata : null
  const metadata = { artist: matched?.artist || item.artist, title: matched?.title || item.title, album: matched?.album || item.album || null, releaseDate: matched?.releaseDate || null, releaseId: matched?.releaseId || null, matchConfidence: metadataResolution?.confidence || 0 }
  const results = await Promise.allSettled([appleArtworkCandidates(env, metadata), spotifyArtworkCandidates(env, metadata), coverArtArchiveCandidates(metadata)])
  const candidates = rankArtworkCandidates([...results.flatMap((result) => result.status === 'fulfilled' ? result.value : []), ...catalogueArtworkCandidates(env, item), ...youtubeArtworkCandidates(sourceCandidate)]).slice(0, 10)
  return { candidates, selectedCandidateId: candidates.find((candidate) => candidate.selectable)?.id || null, resolvedAt: new Date().toISOString(), candidateId: sourceCandidate.id, configurationKey: artworkConfigurationKey(env), providers: { apple: { available: true, acquisitionEnabled: String(env.APPLE_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true' }, spotify: { available: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET), acquisitionEnabled: String(env.SPOTIFY_ARTWORK_EMBEDDING_ENABLED || '').toLowerCase() === 'true' }, coverArtArchive: { available: Boolean(metadata.releaseId) }, youtube: { available: sourceCandidate.backend === 'youtube' && Boolean(sourceCandidate.thumbnail) } } }
}

export async function lookupMusicBrainzReleaseGroup(album) {
  const mbid = typeof album.musicBrainzId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(album.musicBrainzId) ? album.musicBrainzId : null

  if (mbid) {
    const releaseUrl = new URL('https://musicbrainz.org/ws/2/release/' + mbid)
    releaseUrl.searchParams.set('inc', 'release-groups')
    releaseUrl.searchParams.set('fmt', 'json')
    const release = await musicBrainzJson(releaseUrl)
    if (release?.['release-group']?.id) {
      const fullGroupUrl = new URL('https://musicbrainz.org/ws/2/release-group/' + release['release-group'].id)
      fullGroupUrl.searchParams.set('fmt', 'json')
      const fullGroup = await musicBrainzJson(fullGroupUrl)
      if (fullGroup?.id) return { group: fullGroup, score: 100 }
      return { group: release['release-group'], score: 100 }
    }

    const groupUrl = new URL('https://musicbrainz.org/ws/2/release-group/' + mbid)
    groupUrl.searchParams.set('fmt', 'json')
    const group = await musicBrainzJson(groupUrl)
    if (group?.id) return { group, score: 100 }
  }

  const originalTitle = String(album.name || '').replace(/"/g, '').trim()
  const title = cleanReleaseTitle(originalTitle)
  const artist = String(album.artist || '').replace(/"/g, '').trim()
  if (!title || !artist) return null

  const searchUrl = new URL('https://musicbrainz.org/ws/2/release-group/')
  const hintedType = releaseTitleHint(originalTitle)
  const typeQuery = hintedType === 'single' ? ' AND primarytype:single' : hintedType === 'ep' ? ' AND primarytype:ep' : ''
  searchUrl.searchParams.set('query', 'releasegroup:"' + title + '" AND artist:"' + artist + '"' + typeQuery)
  searchUrl.searchParams.set('limit', '5')
  searchUrl.searchParams.set('fmt', 'json')
  const search = await musicBrainzJson(searchUrl)
  const groups = Array.isArray(search?.['release-groups']) ? search['release-groups'] : []
  const wantedTitle = normalise(title)
  const wantedArtist = normalise(artist)

  const candidates = groups.map((group) => {
    const score = Number(group.score || 0)
    const titleMatch = normalise(group.title) === wantedTitle
    const creditedArtist = normalise(artistCredit(group))
    const artistMatch = creditedArtist === wantedArtist || creditedArtist.includes(wantedArtist) || wantedArtist.includes(creditedArtist)
    const yearMatch = album.year && String(group['first-release-date'] || '').startsWith(String(album.year))
    return { group, score: score + (titleMatch ? 15 : 0) + (artistMatch ? 15 : 0) + (yearMatch ? 5 : 0) + releaseGroupTypeFit(group, album.trackCount), rawScore: score, titleMatch, artistMatch }
  }).filter((candidate) => candidate.titleMatch && candidate.artistMatch && candidate.rawScore >= 80)
    .sort((a, b) => b.score - a.score)

  return candidates[0] ? { group: candidates[0].group, score: Math.min(100, candidates[0].rawScore) } : null
}

export async function selectRelease(db, albumId) {
  const row = await db.prepare('SELECT album_id AS albumId, release_type AS releaseType, release_date AS releaseDate, updated_at AS updatedAt, source, musicbrainz_id AS musicBrainzId, match_score AS matchScore FROM release_metadata WHERE album_id = ?').bind(albumId).first()
  return rowToItem(row)
}

export async function handleRecoveryRequest(request, env, url) {
    const pathname = decodeURIComponent(url.pathname)
    if (pathname !== '/api/recovery' && !pathname.startsWith('/api/recovery/')) return null

    // Recovery downloads and imports into the shared library, so every Recovery route is for administrators only.
    if (pathname === '/api/recovery' || pathname.startsWith('/api/recovery/')) {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can use Recovery.' }, 403)
    }

    if (pathname === '/api/recovery' && request.method === 'GET') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const rows = await env.TOMIFY_DB.prepare('SELECT id FROM recovery_items WHERE username = ? ORDER BY updated_at DESC, created_at DESC').bind(username).all()
      const items = []
      for (const row of rows.results || []) items.push(await recoveryItem(env.TOMIFY_DB, username, row.id))
      const configured = Boolean(env.RECOVERY_AGENT_URL)
      const backendState = [
        { id: 'youtube', label: 'YouTube', available: configured, authentication: configured ? 'unavailable' : 'not-configured', reason: configured ? null : 'The media-server recovery agent has not been connected yet.' },
        { id: 'internet-archive', label: 'Internet Archive', available: configured, authentication: 'not-required', reason: configured ? null : 'The media-server recovery agent has not been connected yet.' },
        { id: 'usenet', label: 'Usenet / NZB', available: false, authentication: 'not-configured', reason: configured ? 'Configure SABnzbd or NZBGet and its download directory on the recovery agent.' : 'The media-server recovery agent has not been connected yet.' },
        { id: 'torrent', label: 'Torrents', available: false, search: false, authentication: 'not-configured', reason: configured ? 'Configure qBittorrent and its download directory on the recovery agent.' : 'The media-server recovery agent has not been connected yet.' },
      ]
      if (env.RECOVERY_AGENT_URL) {
        try {
          const status = await recoveryAgentStatus(env)
          for (const backend of backendState) {
            const remote = Array.isArray(status.backends) ? status.backends.find((value) => value?.id === backend.id) : null
            backend.available = Boolean(remote && remote.available !== false)
            backend.authentication = remote?.authentication || backend.authentication
            // Agents older than torrent search only accept pasted links.
            if (backend.id === 'torrent') backend.search = backend.available && remote?.search === true
          }
        } catch { backendState.forEach((backend) => { backend.available = false; backend.authentication = backend.id === 'internet-archive' ? 'not-required' : 'unavailable' }) }
      }
      return json({ items: items.filter(Boolean), backends: backendState })
    }

    if (pathname === '/api/recovery' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const wantedText = (value) => typeof value === 'string' ? value.trim().slice(0, 240) : ''
      // Wanted music can be any mix of artist, album and track; artist and title stay NOT NULL, so blanks are stored as ''.
      const wanted = { artist: wantedText(body?.artist), title: wantedText(body?.title), album: wantedText(body?.album) }
      if (!body || (!wanted.artist && !wanted.title && !wanted.album)) return json({ error: 'invalid-wanted-music', message: 'Enter at least one of artist, album or track.' }, 400)
      const id = crypto.randomUUID()
      await env.TOMIFY_DB.prepare("INSERT INTO recovery_items (id, username, artist, title, album, duration, track_number, disc_number, musicbrainz_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')")
        .bind(id, username, wanted.artist, wanted.title, wanted.album || null, Number.isFinite(body.duration) && body.duration > 0 ? body.duration : null, Number.isInteger(body.trackNumber) && body.trackNumber > 0 ? body.trackNumber : null, Number.isInteger(body.discNumber) && body.discNumber > 0 ? body.discNumber : null, typeof body.musicBrainzId === 'string' ? body.musicBrainzId.slice(0, 64) : null).run()
      return json({ item: await recoveryItem(env.TOMIFY_DB, username, id) }, 201)
    }

    const recoveryMatch = pathname.match(/^\/api\/recovery\/([^/]+)(?:\/(search|select|acquire|job|cancel|import-remaining))?$/)
    if (recoveryMatch && recoveryMatch[2] === 'cancel' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (!item) return json({ error: 'recovery-item-not-found' }, 404)
      const candidate = item.candidates.find((value) => value.selected && value.provenance?.job?.id)
      if (!candidate) return json({ error: 'recovery-job-not-found' }, 404)
      if (!['queued', 'downloading', 'importing'].includes(item.status)) return json({ error: 'recovery-job-not-active', message: 'This recovery job is no longer active.' }, 409)
      try {
        const cancelled = await callRecoveryAgent(env, '/v1/jobs/cancel', { jobId: candidate.provenance.job.id })
        const importedPaths = [...new Set((Array.isArray(cancelled?.importedPaths) ? cancelled.importedPaths : []).filter((path) => typeof path === 'string' && path))]
        if (importedPaths.length) await callRecoveryAgent(env, '/v1/delete', { importedPaths })
        const provenance = { ...candidate.provenance }
        for (const key of ['job', 'importedAt', 'importedCount', 'importedTracks', 'importedRelease', 'remainingImportedAt', 'sourceAudio', 'derivative']) delete provenance[key]
        await env.TOMIFY_DB.batch([
          env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET imported_path = NULL, provenance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(provenance), candidate.id),
          env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'candidate-found', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(item.id, username),
        ])
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The recovery job could not be cancelled.'
        return json({ error: 'recovery-cancel-failed', message }, 502)
      }
    }
    if (recoveryMatch && request.method === 'DELETE' && !recoveryMatch[2]) {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (!item) return json({ error: 'recovery-item-not-found' }, 404)
      // Torrent jobs can be deleted at any point: the agent stops the torrent and removes it and its data from qBittorrent.
      const torrentJobIds = [...new Set(item.candidates.filter((candidate) => candidate.backend === 'torrent' && candidate.provenance?.job?.id).map((candidate) => candidate.provenance.job.id))]
      const activeCandidate = item.candidates.find((candidate) => candidate.selected && candidate.provenance?.job?.id)
      if (item.status === 'importing' || ((item.status === 'queued' || item.status === 'downloading') && activeCandidate?.backend !== 'torrent')) return json({ error: 'recovery-job-active', message: 'Wait for the active recovery job to finish before deleting this item.' }, 409)
      const importedPaths = [...new Set(item.candidates.flatMap((candidate) => [candidate.importedPath, ...(Array.isArray(candidate.provenance?.importedTracks) ? candidate.provenance.importedTracks.map((track) => track?.path) : [])]).filter((path) => typeof path === 'string' && path.length > 0))]
      for (const jobId of torrentJobIds) {
        try {
          const cancelled = await callRecoveryAgent(env, '/v1/jobs/cancel', { jobId })
          // A torrent that finished importing while it was being deleted still has its files removed below.
          for (const path of Array.isArray(cancelled?.importedPaths) ? cancelled.importedPaths : []) if (typeof path === 'string' && path && !importedPaths.includes(path)) importedPaths.push(path)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Torrent removal failed.'
          return json({ error: 'recovery-delete-failed', message: 'The torrent could not be removed from qBittorrent. The queue item was kept. ' + message }, 502)
        }
      }
      if (importedPaths.length) {
        try {
          await callRecoveryAgent(env, '/v1/delete', { importedPaths })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Recovery library cleanup failed.'
          return json({ error: 'recovery-delete-failed', message: 'Files could not be removed from the recovery library. The queue item was kept. ' + message }, 502)
        }
      }
      await env.TOMIFY_DB.batch([
        env.TOMIFY_DB.prepare('DELETE FROM recovery_candidates WHERE recovery_id = ?').bind(item.id),
        env.TOMIFY_DB.prepare('DELETE FROM recovery_items WHERE id = ? AND username = ?').bind(item.id, username),
      ])
      return json({ deleted: true, filesRemoved: importedPaths.length > 0 })
    }

    if (recoveryMatch && request.method === 'PATCH' && !recoveryMatch[2]) {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const allowed = ['missing', 'candidate-found', 'recovered', 'needs-upgrade', 'failed']
      if (!body || !allowed.includes(body.status)) return json({ error: 'invalid-recovery-status' }, 400)
      await env.TOMIFY_DB.prepare('UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(body.status, recoveryMatch[1], username).run()
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      return item ? json({ item }) : json({ error: 'recovery-item-not-found' }, 404)
    }

    if (recoveryMatch && recoveryMatch[2] === 'search' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (!item) return json({ error: 'recovery-item-not-found' }, 404)
      if (item.status === 'queued' || item.status === 'downloading') return json({ error: 'recovery-job-active', message: 'Wait for the active recovery job to finish before searching again.' }, 409)
      const body = await request.json().catch(() => ({}))
      const backend = ['internet-archive', 'youtube', 'usenet', 'torrent'].includes(body?.backend) ? body.backend : null
      if (!backend) return json({ error: 'unsupported-recovery-backend' }, 400)
      // A torrent search either sends a pasted magnet or .torrent link, which the agent validates and returns as one
      // candidate, or no link, which searches qBittorrent's search plugins for results that have seeds.
      const link = typeof body?.link === 'string' ? body.link.trim() : ''
      if (backend === 'torrent' && ((typeof body?.link === 'string' && !link) || link.length > 8000)) return json({ error: 'invalid-torrent-link', message: 'Paste a magnet link or a link to a .torrent file.' }, 400)
      const usenetFields = ['artist', 'album', 'track']
      const searchFields = Array.isArray(body?.searchFields) ? usenetFields.filter((field) => body.searchFields.includes(field)) : null
      if ((backend === 'usenet' || backend === 'torrent' && !link) && searchFields && !searchFields.length) return json({ error: 'invalid-search-fields', message: backend === 'torrent' ? 'Choose at least one of artist, album or track to search torrents.' : 'Choose at least one of artist, album or track to search Usenet.' }, 400)
      // The legacy searchMode rides along so a recovery agent older than searchFields still runs its closest single-field search.
      const searchMode = searchFields ? (searchFields.includes('track') ? 'track' : searchFields.includes('album') ? 'release' : 'artist') : ['artist', 'track', 'release'].includes(body?.searchMode) ? body.searchMode : 'track'
      try {
        await requireRecoveryAgentContract(env)
        const result = await callRecoveryAgent(env, '/v1/search', { backend, searchMode, ...(searchFields ? { searchFields } : {}), ...(backend === 'torrent' && link ? { link } : {}), track: { artist: item.artist, title: item.title, album: item.album, duration: item.duration } })
        const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 12) : []
        await env.TOMIFY_DB.prepare('DELETE FROM recovery_candidates WHERE recovery_id = ? AND backend = ? AND imported_path IS NULL').bind(item.id, backend).run()
        const inserts = candidates.filter((candidate) => candidate && typeof candidate.url === 'string' && typeof candidate.externalId === 'string').map((candidate) => {
          const scored = scoreRecoveryCandidate(item, candidate)
          return env.TOMIFY_DB.prepare('INSERT INTO recovery_candidates (id, recovery_id, backend, external_id, url, title, channel, channel_id, duration, official, match_score, thumbnail, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), item.id, backend, candidate.externalId.slice(0, 120), candidate.url.slice(0, 1000), String(candidate.title || '').slice(0, 500), String(candidate.channel || (backend === 'youtube' ? 'Unknown channel' : backend === 'usenet' ? 'Newznab indexer' : backend === 'torrent' ? (link ? 'Torrent link' : 'Torrent search') : 'Internet Archive')).slice(0, 240), typeof candidate.channelId === 'string' ? candidate.channelId.slice(0, 120) : null, Number.isFinite(candidate.duration) ? candidate.duration : null, scored.official ? 1 : 0, scored.score, typeof candidate.thumbnail === 'string' ? candidate.thumbnail.slice(0, 1000) : null, JSON.stringify({ discoveredAt: new Date().toISOString(), backend, searchMode: candidate.provenance?.searchMode || searchMode, searchFields: candidate.provenance?.searchFields || searchFields, raw: candidate.provenance || null }))
        })
        if (inserts.length) await env.TOMIFY_DB.batch(inserts)
        const retainedSelection = item.candidates.find((candidate) => candidate.selected && (candidate.backend !== backend || candidate.importedPath))
        const candidateCount = inserts.length + item.candidates.filter((candidate) => candidate.backend !== backend || candidate.importedPath).length
        if (retainedSelection) await env.TOMIFY_DB.prepare('UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(retainedSelection.importedPath ? item.status : 'candidate-found', item.id, username).run()
        else await env.TOMIFY_DB.prepare('UPDATE recovery_items SET status = ?, selected_candidate_id = NULL, metadata_resolution_json = NULL, artwork_resolution_json = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(candidateCount ? 'candidate-found' : 'missing', item.id, username).run()
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Candidate search failed.'
        if (error instanceof RecoveryAgentOutdated) return json({ error: 'recovery-agent-outdated', message }, 409)
        await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(message.slice(0, 500), item.id, username).run()
        return json({ error: 'candidate-search-failed', message }, 502)
      }
    }

    if (recoveryMatch && recoveryMatch[2] === 'select' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (item?.status === 'queued' || item?.status === 'downloading') return json({ error: 'recovery-job-active', message: 'Wait for the active recovery job to finish before changing candidates.' }, 409)
      const candidate = body && typeof body.candidateId === 'string' ? item?.candidates.find((value) => value.id === body.candidateId) : null
      if (!candidate) return json({ error: 'recovery-candidate-not-found' }, 404)
      let metadataResolution
      const cachedResolution = item.metadataResolution?.candidateId === candidate.id && Date.now() - Date.parse(item.metadataResolution.resolvedAt || '') < 30 * 24 * 60 * 60 * 1000 && item.metadataResolution.status !== 'unavailable' ? item.metadataResolution : null
      try { metadataResolution = cachedResolution || await resolveMusicBrainzRecovery(item, candidate.id) }
      catch { metadataResolution = { authority: 'musicbrainz', status: 'unavailable', confidence: 0, strong: false, metadata: null, candidateId: candidate.id, resolvedAt: new Date().toISOString() } }
      let artworkResolution
      const cachedArtwork = item.artworkResolution?.candidateId === candidate.id && item.artworkResolution?.configurationKey === artworkConfigurationKey(env) && Date.now() - Date.parse(item.artworkResolution.resolvedAt || '') < 30 * 24 * 60 * 60 * 1000 ? item.artworkResolution : null
      try { artworkResolution = cachedArtwork || await resolveRecoveryArtwork(env, metadataResolution, item, candidate) }
      catch { artworkResolution = { candidates: rankArtworkCandidates(youtubeArtworkCandidates(candidate)), selectedCandidateId: candidate.backend === 'youtube' && candidate.thumbnail ? 'youtube:' + candidate.externalId : null, candidateId: candidate.id, configurationKey: artworkConfigurationKey(env), resolvedAt: new Date().toISOString(), providers: {} } }
      await env.TOMIFY_DB.batch([env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 0 WHERE recovery_id = ?').bind(recoveryMatch[1]), env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(body.candidateId), env.TOMIFY_DB.prepare("UPDATE recovery_items SET selected_candidate_id = ?, metadata_resolution_json = ?, artwork_resolution_json = ?, status = 'candidate-found', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(body.candidateId, JSON.stringify(metadataResolution), JSON.stringify(artworkResolution), recoveryMatch[1], username)])
      return json({ item: await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1]) })
    }

    if (recoveryMatch && recoveryMatch[2] === 'job' && request.method === 'GET') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      const candidate = item?.candidates.find((value) => value.selected && value.provenance?.job?.id)
      if (!item || !candidate) return json({ error: 'recovery-job-not-found' }, 404)
      try {
        // The agent's job runner downloads and imports on its own; this only reads the job to update the item for the page.
        const result = await callRecoveryAgent(env, '/v1/jobs/status', { jobId: candidate.provenance.job.id })
        const job = result.job || {}
        const provenance = { ...candidate.provenance, job: { ...candidate.provenance.job, id: candidate.provenance.job.id, status: job.status || 'queued', progress: Number.isFinite(job.progress) ? job.progress : 0, message: job.message || null, error: job.error || null, details: job.details && typeof job.details === 'object' ? job.details : null } }
        if (job.status === 'completed' && job.result) {
          const quality = job.result.quality || {}
          const importedTracks = Array.isArray(job.result.importedTracks) ? job.result.importedTracks.map((track) => importedTrackMetadata(track, job.result)) : []
          const importedCount = Number.isInteger(job.result.importedCount) ? job.result.importedCount : importedTracks.length || 1
          const finalProvenance = { ...provenance, ...(job.result.provenance || {}), source: job.result.provenance?.source || candidate.backend, job: provenance.job, importedAt: new Date().toISOString(), importedCount, importedTracks, importedRelease: importedCount > 1 ? { artist: job.result.artist || null, album: job.result.album || null } : null, ...(job.result.completeness ? { completeness: job.result.completeness, extraFiles: job.result.extraFiles || [] } : {}) }
          await env.TOMIFY_DB.batch([
            env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET codec = ?, container = ?, bitrate = ?, sample_rate = ?, channels = ?, duration = COALESCE(?, duration), imported_path = ?, provenance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(quality.codec || null, quality.container || null, Number.isFinite(quality.bitrate) ? quality.bitrate : null, Number.isFinite(quality.sampleRate) ? quality.sampleRate : null, Number.isFinite(quality.channels) ? quality.channels : null, Number.isFinite(quality.duration) ? quality.duration : null, String(job.result.path || '').slice(0, 1000), JSON.stringify(finalProvenance), candidate.id),
            env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(recoveryImportStatus(quality), item.id, username),
          ])
          await linkReleaseImport(env.TOMIFY_DB, username, item, candidate, job.result)
          await markRecoveryScanPending(request, env, username, item.id)
        } else if (job.status === 'failed') {
          await env.TOMIFY_DB.batch([
            env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET provenance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(provenance), candidate.id),
            env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(String(job.error || 'The download failed.').slice(0, 500), item.id, username),
          ])
        } else {
          const status = job.status === 'downloading' ? 'downloading' : 'queued'
          await env.TOMIFY_DB.batch([
            env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET provenance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(provenance), candidate.id),
            env.TOMIFY_DB.prepare('UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(status, item.id, username),
          ])
        }
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        if (isNavidromeConfigurationError(error)) throw error
        const message = error instanceof Error ? error.message : 'Could not poll the recovery download job.'
        return json({ error: 'recovery-job-poll-failed', message }, 502)
      }
    }

    if (recoveryMatch && recoveryMatch[2] === 'import-remaining' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      const candidate = item?.candidates.find((value) => value.selected && value.backend === 'usenet' && value.importedPath && value.provenance?.job?.id)
      if (!item || !candidate) return json({ error: 'recovery-download-not-found', message: 'Only a completed Usenet import can have the rest of its download imported.' }, 404)
      try {
        await requireRecoveryAgentContract(env)
        const { result } = await callRecoveryAgent(env, '/v1/jobs/import-remaining', { jobId: candidate.provenance.job.id })
        const added = Array.isArray(result?.importedTracks) ? result.importedTracks.map((track) => ({ path: track?.path || null, originalPath: track?.originalPath || null, artist: track?.artist || null, albumArtist: track?.albumArtist || null, album: track?.album || null, title: track?.title || null, trackNumber: track?.trackNumber || null, discNumber: track?.discNumber || null, quality: track?.quality || null, derivative: track?.derivative || null })) : []
        // Keep the added tracks on the candidate so deleting the item also removes them.
        const importedTracks = [...(Array.isArray(candidate.provenance.importedTracks) ? candidate.provenance.importedTracks : []), ...added]
        const provenance = { ...candidate.provenance, importedTracks, importedCount: Math.max(importedTracks.length, Number(candidate.provenance.importedCount) || 1), importedRelease: { artist: result?.artist || null, album: result?.album || null }, remainingImportedAt: new Date().toISOString() }
        await env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET provenance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(provenance), candidate.id).run()
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not import the rest of the download.'
        if (error instanceof RecoveryAgentOutdated) return json({ error: 'recovery-agent-outdated', message }, 409)
        return json({ error: 'recovery-import-remaining-failed', message }, 502)
      }
    }

    if (recoveryMatch && recoveryMatch[2] === 'acquire' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request, env)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const rights = ['uploader-authorised', 'creative-commons', 'public-domain', 'other-authorisation']
      if (!body || body.confirmedAuthorised !== true || !rights.includes(body.rightsBasis) || typeof body.candidateId !== 'string') return json({ error: 'source-authorisation-required' }, 400)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      const candidate = item?.candidates.find((value) => value.id === body.candidateId)
      if (!item || !candidate) return json({ error: 'recovery-candidate-not-found' }, 404)
      if (item.metadataResolution?.candidateId !== candidate.id) return json({ error: 'recovery-metadata-review-required', message: 'Select this candidate again to resolve and review its metadata before importing.' }, 409)
      if (item.artworkResolution?.candidateId !== candidate.id) return json({ error: 'recovery-artwork-review-required', message: 'Select this candidate again to resolve and review its artwork before importing.' }, 409)
      const metadataChoices = body.metadataChoices && typeof body.metadataChoices === 'object' ? body.metadataChoices : {}
      const wantedMetadata = { artist: item.artist, title: item.title, album: item.album || null, releaseDate: null, trackNumber: item.trackNumber || null, discNumber: item.discNumber || null, duration: item.duration || null, recordingId: item.musicBrainzId || null }
      const resolvedMetadata = applyRecoveryMetadataChoices(wantedMetadata, item.metadataResolution, metadataChoices)
      const artwork = body.artworkCandidateId == null ? null : item.artworkResolution.candidates.find((value) => value.id === body.artworkCandidateId && value.selectable === true)
      if (body.artworkCandidateId != null && !artwork) return json({ error: 'invalid-recovery-artwork', message: 'The selected artwork is unavailable or is not approved for acquisition.' }, 400)
      try { await requireRecoveryAgentContract(env) }
      catch (error) {
        if (error instanceof RecoveryAgentOutdated) return json({ error: 'recovery-agent-outdated', message: error.message }, 409)
        return json({ error: 'recovery-agent-status-failed', message: error instanceof Error ? error.message : 'The recovery agent status is unavailable.' }, 502)
      }
      await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'importing', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(item.id, username).run()
      try {
        let tracklist = null
        try { tracklist = await recoveryReleaseTracklist(env.TOMIFY_DB, item, candidate, resolvedMetadata, username) }
        catch { /* Tracklists are optional so an unavailable MusicBrainz lookup keeps old-agent behaviour. */ }
        // background asks the agent to queue YouTube and Internet Archive acquisitions as jobs (202) like Usenet and
        // torrents; an older agent ignores it and answers synchronously, which the branch below still handles.
        const result = await callRecoveryAgent(env, '/v1/acquire', { backend: candidate.backend, background: true, candidate: { externalId: candidate.externalId, url: candidate.url, title: candidate.title, channel: candidate.channel, provenance: candidate.provenance?.raw || null }, track: resolvedMetadata, ...(tracklist ? { tracklist } : {}), wantedMetadata, catalogueSource: item.catalogueSource || null, metadataResolution: { authority: 'musicbrainz', status: item.metadataResolution.status, confidence: item.metadataResolution.confidence, strong: item.metadataResolution.strong, choices: metadataChoices }, artwork: artwork ? { id: artwork.id, provider: artwork.provider, providerLabel: artwork.providerLabel, providerId: artwork.providerId, url: artwork.url, expectedWidth: artwork.width || null, expectedHeight: artwork.height || null, confidence: artwork.confidence } : null, authorisation: { confirmed: true, basis: body.rightsBasis, confirmedBy: username, confirmedAt: new Date().toISOString() }, skipExisting: body.skipExisting === true })
        const quality = result.quality || {}
        const provenance = { ...(candidate.provenance || {}), ...(result.provenance || {}), source: result.provenance?.source || candidate.backend, sourceUrl: result.provenance?.sourceUrl || candidate.url, catalogueSource: item.catalogueSource || null, rightsBasis: body.rightsBasis, archiveStatus: result.provenance?.archiveStatus || 'recovery-copy', importedAt: result.job ? null : new Date().toISOString(), wantedMetadata, resolvedMetadata, metadataResolution: { authority: 'musicbrainz', status: item.metadataResolution.status, confidence: item.metadataResolution.confidence, strong: item.metadataResolution.strong, choices: metadataChoices }, job: result.job || null }
        if (result.job) {
          await env.TOMIFY_DB.batch([
            env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 1, provenance_json = ?, rights_basis = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(provenance), body.rightsBasis, candidate.id),
            env.TOMIFY_DB.prepare("UPDATE recovery_items SET selected_candidate_id = ?, status = 'queued', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(candidate.id, item.id, username),
          ])
          return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) }, 202)
        }
        await env.TOMIFY_DB.batch([
          env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 1, codec = ?, container = ?, bitrate = ?, sample_rate = ?, channels = ?, duration = COALESCE(?, duration), imported_path = ?, provenance_json = ?, rights_basis = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(quality.codec || null, quality.container || null, Number.isFinite(quality.bitrate) ? quality.bitrate : null, Number.isFinite(quality.sampleRate) ? quality.sampleRate : null, Number.isFinite(quality.channels) ? quality.channels : null, Number.isFinite(quality.duration) ? quality.duration : null, String(result.path || '').slice(0, 1000), JSON.stringify(provenance), body.rightsBasis, candidate.id),
          env.TOMIFY_DB.prepare("UPDATE recovery_items SET selected_candidate_id = ?, status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(candidate.id, recoveryImportStatus(quality), item.id, username),
        ])
        await markRecoveryScanPending(request, env, username, item.id)
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        if (isNavidromeConfigurationError(error)) throw error
        const message = error instanceof Error ? error.message : 'Import failed.'
        await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(message.slice(0, 500), item.id, username).run()
        return json({ error: 'recovery-import-failed', message }, 502)
      }
    }


    return json({ error: 'not-found' }, 404)
}
