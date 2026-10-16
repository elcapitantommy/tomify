import { normaliseCatalogueText } from '../src/lib/catalogue-match.mjs'

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
