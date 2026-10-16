export function normaliseMetadataText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

function editDistance(left, right) {
  const a = normaliseMetadataText(left)
  const b = normaliseMetadataText(right)
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= b.length; column += 1) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}

export function metadataTextSimilarity(left, right) {
  const a = normaliseMetadataText(left)
  const b = normaliseMetadataText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const edit = 1 - editDistance(a, b) / Math.max(a.length, b.length)
  const aTokens = new Set(a.split(' '))
  const bTokens = new Set(b.split(' '))
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length
  const tokenScore = intersection / Math.max(aTokens.size, bTokens.size)
  return Math.max(0, Math.min(1, Math.max(edit, tokenScore)))
}

function creditedArtist(recording) {
  return (Array.isArray(recording?.['artist-credit']) ? recording['artist-credit'] : []).map((credit) => `${credit?.name || credit?.artist?.name || ''}${credit?.joinphrase || ''}`).join('').trim()
}

function numericTrack(value, fallback = null) {
  const matched = String(value || '').match(/^\d+/)
  return matched ? Number(matched[0]) : fallback
}

function releaseDetails(recording, wantedAlbum) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : []
  const ranked = releases.map((release) => {
    const albumSimilarity = wantedAlbum ? metadataTextSimilarity(wantedAlbum, release?.title) : metadataTextSimilarity(recording?.title, release?.title)
    const official = String(release?.status || '').toLocaleLowerCase('en') === 'official'
    const media = Array.isArray(release?.media) ? release.media : []
    const medium = media.find((entry) => Array.isArray(entry?.track) && entry.track.some((track) => !track?.recording?.id || track.recording.id === recording.id)) || media[0] || null
    const tracks = Array.isArray(medium?.track) ? medium.track : []
    const trackIndex = tracks.findIndex((track) => track?.recording?.id === recording.id || metadataTextSimilarity(track?.title, recording?.title) >= 0.98)
    const track = trackIndex >= 0 ? tracks[trackIndex] : tracks[0]
    const score = albumSimilarity * (wantedAlbum ? 80 : 55) + (official ? 12 : 0) + (release?.date ? 5 : 0) + (track ? 3 : 0)
    return { release, medium, track, trackIndex, albumSimilarity, score }
  }).sort((left, right) => right.score - left.score)
  return ranked[0] || null
}

function durationConfidence(expectedSeconds, actualMilliseconds) {
  if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0 || !Number.isFinite(actualMilliseconds) || actualMilliseconds <= 0) return { score: 0.55, difference: null }
  const difference = Math.abs(expectedSeconds - actualMilliseconds / 1000)
  const score = difference <= 2 ? 1 : difference <= 5 ? 0.9 : difference <= 10 ? 0.68 : difference <= 20 ? 0.3 : 0
  return { score, difference }
}

export function resolveRecoveryMetadata(wanted, recordings) {
  const candidates = (Array.isArray(recordings) ? recordings : []).map((recording) => {
    const artist = creditedArtist(recording)
    const titleSimilarity = metadataTextSimilarity(wanted?.title, recording?.title)
    const artistSimilarity = metadataTextSimilarity(wanted?.artist, artist)
    const release = releaseDetails(recording, wanted?.album)
    const albumSimilarity = wanted?.album ? release?.albumSimilarity || 0 : 1
    const duration = durationConfidence(Number(wanted?.duration), Number(recording?.length))
    const isrcMatch = Boolean(wanted?.isrc && Array.isArray(recording?.isrcs) && recording.isrcs.some((isrc) => normaliseMetadataText(isrc) === normaliseMetadataText(wanted.isrc)))
    const searchScore = Math.max(0, Math.min(100, Number(recording?.score || 0))) / 100
    const confidence = wanted?.album
      ? titleSimilarity * 30 + artistSimilarity * 25 + albumSimilarity * 25 + duration.score * 15 + searchScore * 5
      : titleSimilarity * 38 + artistSimilarity * 30 + duration.score * 22 + searchScore * 10
    const adjustedConfidence = confidence + (isrcMatch ? 15 : 0) - (recording?.video === true ? 8 : 0)
    const mediumPosition = Number(release?.medium?.position)
    const trackPosition = release?.track ? numericTrack(release.track.number, release.trackIndex >= 0 ? release.trackIndex + 1 : null) : null
    return {
      confidence: Math.max(0, Math.min(100, Math.round(adjustedConfidence))), titleSimilarity, artistSimilarity, albumSimilarity, isrcMatch,
      durationDifference: duration.difference,
      metadata: {
        artist: artist || null,
        title: String(recording?.title || '').trim() || null,
        album: String(release?.release?.title || '').trim() || null,
        releaseDate: String(release?.release?.date || recording?.['first-release-date'] || '').trim() || null,
        trackNumber: Number.isInteger(trackPosition) && trackPosition > 0 ? trackPosition : null,
        discNumber: Number.isInteger(mediumPosition) && mediumPosition > 0 ? mediumPosition : null,
        recordingId: String(recording?.id || '').trim() || null,
        releaseId: String(release?.release?.id || '').trim() || null,
        releaseGroupId: String(release?.release?.['release-group']?.id || '').trim() || null,
        duration: Number.isFinite(recording?.length) ? Number(recording.length) / 1000 : null,
        isrc: Array.isArray(recording?.isrcs) && recording.isrcs.length ? String(recording.isrcs[0]) : null,
      },
    }
  }).filter((candidate) => candidate.metadata.artist && candidate.metadata.title).sort((left, right) => right.confidence - left.confidence || Number(right.isrcMatch) - Number(left.isrcMatch))

  if (!candidates.length) return { status: 'not-found', confidence: 0, strong: false, metadata: null }
  const best = candidates[0]
  const second = candidates[1]
  const bestKey = normaliseMetadataText(`${best.metadata.artist}|${best.metadata.title}|${wanted?.album ? best.metadata.album : ''}`)
  const secondKey = second ? normaliseMetadataText(`${second.metadata.artist}|${second.metadata.title}|${wanted?.album ? second.metadata.album : ''}`) : null
  const ambiguous = Boolean(second && secondKey !== bestKey && best.confidence - second.confidence < 5)
  const durationAcceptable = best.durationDifference == null || best.durationDifference <= 20
  const strong = best.confidence >= 82 && best.titleSimilarity >= 0.82 && best.artistSimilarity >= 0.78 && (!wanted?.album || best.albumSimilarity >= 0.72) && durationAcceptable && !ambiguous
  return { status: strong ? 'matched' : 'unconfirmed', confidence: best.confidence, strong, ambiguous, metadata: best.metadata }
}

export function applyRecoveryMetadataChoices(wanted, resolution, choices) {
  const matched = resolution?.strong ? resolution.metadata : null
  const use = choices && typeof choices === 'object' ? choices : {}
  return {
    artist: use.artist === true && matched?.artist ? matched.artist : wanted.artist,
    title: use.title === true && matched?.title ? matched.title : wanted.title,
    album: use.album === true && matched?.album ? matched.album : wanted.album || null,
    releaseDate: use.releaseDate === true && matched?.releaseDate ? matched.releaseDate : wanted.releaseDate || null,
    trackNumber: use.trackNumbers === true && Number.isInteger(matched?.trackNumber) ? matched.trackNumber : wanted.trackNumber || null,
    discNumber: use.trackNumbers === true && Number.isInteger(matched?.discNumber) ? matched.discNumber : wanted.discNumber || null,
    duration: matched?.duration || wanted.duration || null,
    recordingId: matched?.recordingId || null,
    releaseId: matched?.releaseId || null,
    releaseGroupId: matched?.releaseGroupId || null,
    isrc: matched?.isrc || null,
  }
}

// A lossless import (FLAC, ALAC, WAV and similar) is an acceptable recovery; anything lossy still needs a better copy.
// Either way it stays a recovery copy, never a verified archival master.
export const recoveryMetadataWorkerSource = [normaliseMetadataText, editDistance, metadataTextSimilarity, creditedArtist, numericTrack, releaseDetails, durationConfidence, resolveRecoveryMetadata, applyRecoveryMetadataChoices].map((fn) => fn.toString()).join('\n\n')
