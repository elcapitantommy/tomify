export function parseSpotifyPlaylistId(value) {
  const input = String(value || '').trim()
  const uri = input.match(/^spotify:playlist:([A-Za-z0-9]{10,40})$/)
  if (uri) return uri[1]
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null
    const match = url.pathname.match(/^\/playlist\/([A-Za-z0-9]{10,40})\/?$/)
    return match?.[1] || null
  } catch { return null }
}

export function normaliseCatalogueText(value) {
  return String(value || '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function catalogueSimilarity(expected, actual) {
  const left = new Set(normaliseCatalogueText(expected).split(' ').filter(Boolean))
  const right = new Set(normaliseCatalogueText(actual).split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function versionSignals(value) {
  const text = normaliseCatalogueText(value)
  return ['live', 'remix', 'acoustic', 'radio edit', 'karaoke', 'cover', 'sped up', 'slowed', 'instrumental'].filter((signal) => text.includes(signal))
}

export function scoreCatalogueMatch(wanted, candidate) {
  const wantedRecordingId = normaliseCatalogueText(wanted.musicBrainzRecordingId)
  const candidateRecordingId = normaliseCatalogueText(candidate.musicBrainzId || candidate.musicBrainzRecordingId)
  if (wantedRecordingId && candidateRecordingId && wantedRecordingId === candidateRecordingId) return 100
  const wantedIsrc = normaliseCatalogueText(wanted.isrc)
  const candidateIsrc = normaliseCatalogueText(candidate.isrc)
  if (wantedIsrc && candidateIsrc && wantedIsrc === candidateIsrc) return 99
  const wantedVersions = versionSignals(wanted.title)
  const candidateVersions = versionSignals(candidate.title)
  if (wantedVersions.some((signal) => !candidateVersions.includes(signal)) || candidateVersions.some((signal) => !wantedVersions.includes(signal))) return 0
  const title = catalogueSimilarity(wanted.title, candidate.title)
  const artist = catalogueSimilarity((wanted.artists || [wanted.artist]).join(' '), candidate.artist)
  const album = wanted.album ? catalogueSimilarity(wanted.album, candidate.album) : 0.5
  const durationDifference = wanted.duration && candidate.duration ? Math.abs(Number(wanted.duration) - Number(candidate.duration)) : null
  const duration = durationDifference == null ? 0.5 : durationDifference <= 2 ? 1 : durationDifference <= 5 ? 0.8 : durationDifference <= 10 ? 0.35 : 0
  if (title < 0.65 || artist < 0.65) return Math.round((title * 0.55 + artist * 0.35 + duration * 0.1) * 70)
  return Math.round(Math.min(98, title * 43 + artist * 35 + album * 12 + duration * 10))
}

export function matchCatalogueTrack(wanted, candidates) {
  const ranked = (Array.isArray(candidates) ? candidates : []).map((track) => ({ track, confidence: scoreCatalogueMatch(wanted, track) })).filter((match) => match.confidence > 0).sort((left, right) => right.confidence - left.confidence)
  const best = ranked[0]
  if (!best || best.confidence < 72) return { status: 'missing', confidence: best?.confidence || 0, match: null, candidates: ranked.slice(0, 3) }
  const ambiguous = ranked[1] && ranked[1].confidence >= 72 && best.confidence - ranked[1].confidence <= 4
  if (best.confidence < 92 || ambiguous) return { status: 'review', confidence: best.confidence, match: best.track, candidates: ranked.slice(0, 3) }
  return { status: 'available', confidence: best.confidence, match: best.track, candidates: ranked.slice(0, 3) }
}

export function occurrenceKeys(items) {
  const counts = new Map()
  return items.map((item) => {
    const base = item.providerTrackId || 'unavailable:' + normaliseCatalogueText(item.title) + ':' + normaliseCatalogueText((item.artists || []).join(' '))
    const occurrence = (counts.get(base) || 0) + 1
    counts.set(base, occurrence)
    return base + '#' + occurrence
  })
}

export function diffCataloguePlaylist(previous, next) {
  const before = occurrenceKeys(previous)
  const after = occurrenceKeys(next)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((key) => !beforeSet.has(key)),
    removed: before.filter((key) => !afterSet.has(key)),
    reordered: before.filter((key) => afterSet.has(key)).some((key) => before.indexOf(key) !== after.indexOf(key)),
  }
}

export function reusableRecoveryId(wanted, recoveryItems) {
  const spotifyTrackId = wanted.providerTrackId || null
  const artist = normaliseCatalogueText((wanted.artists || []).join(' '))
  const title = normaliseCatalogueText(wanted.title)
  const match = (Array.isArray(recoveryItems) ? recoveryItems : []).find((item) => item.catalogueSource?.spotifyTrackId && item.catalogueSource.spotifyTrackId === spotifyTrackId)
    || (Array.isArray(recoveryItems) ? recoveryItems : []).find((item) => normaliseCatalogueText(item.artist) === artist && normaliseCatalogueText(item.title) === title)
  return match?.id || null
}

export function shouldCreateRecovery(item, createRecovery) {
  return Boolean(createRecovery && item?.status === 'missing' && item?.title && Array.isArray(item.artists) && item.artists.length)
}

export function mapSpotifyPlaylist(playlist, entries, sourceUrl) {
  const items = entries.map((entry, position) => {
    const track = entry?.item || entry?.track || null
    const unavailableReason = !track ? 'unavailable' : track.type === 'episode' ? 'episode' : track.is_local ? 'local-file' : track.type && track.type !== 'track' ? 'unsupported-item' : null
    if (unavailableReason) return { position, status: 'unavailable', unavailableReason, providerTrackId: track?.id || null, title: track?.name || 'Unavailable Spotify item', artists: (track?.artists || []).map((artist) => artist.name), album: track?.album?.name || null }
    return {
      position, status: 'unmatched', providerTrackId: track.id, providerAlbumId: track.album?.id || null,
      providerArtistIds: (track.artists || []).map((artist) => artist.id).filter(Boolean), title: track.name,
      artists: (track.artists || []).map((artist) => artist.name).filter(Boolean), album: track.album?.name || null,
      albumType: track.album?.album_type || null, duration: track.duration_ms ? track.duration_ms / 1000 : null,
      discNumber: track.disc_number || null, trackNumber: track.track_number || null, releaseDate: track.album?.release_date || null,
      isrc: track.external_ids?.isrc || null, explicit: Boolean(track.explicit), artwork: (track.album?.images || []).map((image) => ({ url: image.url, width: image.width || null, height: image.height || null })),
      sourceUrl: track.external_urls?.spotify || null,
    }
  })
  return { provider: 'spotify', providerPlaylistId: playlist.id, name: playlist.name, description: playlist.description || null, sourceUrl, snapshotId: playlist.snapshot_id || null, artwork: (playlist.images || []).map((image) => ({ url: image.url, width: image.width || null, height: image.height || null })), items }
}

export const catalogueImportWorkerSource = [parseSpotifyPlaylistId, normaliseCatalogueText, occurrenceKeys, diffCataloguePlaylist, reusableRecoveryId, shouldCreateRecovery, mapSpotifyPlaylist].map((fn) => fn.toString()).join('\n\n')
