// Album artwork overrides: looks up Spotify artwork for albums already in the Navidrome
// library and stores the chosen image per album in D1. Navidrome's own files are never
// touched; Tomify shows the override instead of getCoverArt wherever it draws that album.
// The pure helpers are exported for tests; handleAlbumArtworkRequest relies on Worker
// globals (authenticate, json, spotifyAccessToken, spotifyTokenCache, rankArtworkCandidates,
// metadataTextSimilarity, artworkYearScore, cleanReleaseTitle, selectRelease, ensureReleaseTable).

export const albumArtworkHosts = ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com']

export function isAlbumArtworkUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && albumArtworkHosts.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

// Spotify often names the edition ("Abbey Road (Remastered 2009)", "Flood - Deluxe Edition")
// while a library folder does not, or the other way round, so titles are also compared
// with trailing bracketed or dashed edition qualifiers removed.
export function baseAlbumTitle(name) {
  const original = String(name || '').trim()
  let title = original
  let previous = ''
  while (title && title !== previous) {
    previous = title
    title = title.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '').trim()
    title = title.replace(/\s+[-\u2013\u2014]\s+[^-\u2013\u2014]*\b(?:remaster\w*|deluxe|edition|expanded|anniversary|reissue|version|mono|stereo|bonus)\b[^-\u2013\u2014]*$/i, '').trim()
  }
  return title || original
}

export function albumArtworkSearchQueries(album, artist) {
  const base = baseAlbumTitle(album)
  return [...new Set([`album:${base} artist:${artist}`, `${base} ${artist}`])]
}

// Scores one Spotify album search result against a library album. `similarity` and
// `yearScore` are the Worker's metadataTextSimilarity and artworkYearScore.
export function spotifyAlbumCandidate(wanted, album, similarity, yearScore) {
  const artists = (Array.isArray(album?.artists) ? album.artists : []).map((artist) => artist?.name).filter(Boolean)
  const artistSimilarity = Math.max(0, similarity(wanted.artist, artists.join(' ')), ...artists.map((name) => similarity(wanted.artist, name)))
  // An exact edition match ranks slightly above a match on the base title alone.
  const albumSimilarity = Math.max(similarity(wanted.album, album?.name), similarity(baseAlbumTitle(wanted.album), baseAlbumTitle(album?.name)) * 0.96)
  if (artistSimilarity < 0.82 || albumSimilarity < 0.8) return null
  const image = (Array.isArray(album.images) ? album.images : []).slice().sort((left, right) => Number(right.width || 0) - Number(left.width || 0))[0]
  if (!isAlbumArtworkUrl(image?.url)) return null
  const confidence = Math.round(artistSimilarity * 50 + albumSimilarity * 40 + yearScore(wanted.releaseDate, album.release_date) * 10)
  return { id: 'spotify:' + album.id, provider: 'spotify', providerLabel: 'Spotify', providerId: album.id, url: image.url, previewUrl: image.url, width: image.width || null, height: image.height || null, confidence, artist: artists.join(', ') || null, album: album.name || null, releaseDate: album.release_date || null, storeUrl: album.external_urls?.spotify || null, selectable: true, unavailableReason: null }
}

// Automatic replacement only takes a confident, clean square Spotify image of at least 600px.
// Anything weaker is left for the album page, where a person can pick or decline it.
export function chooseAutomaticAlbumArtwork(candidates, minimumConfidence = 85) {
  return (Array.isArray(candidates) ? candidates : []).find((candidate) =>
    candidate?.provider === 'spotify' && isAlbumArtworkUrl(candidate.url) && candidate.square && Number(candidate.minimumDimension || 0) >= 600 && Number(candidate.confidence || 0) >= minimumConfidence) || null
}

export function albumArtworkRow(row) {
  if (!row) return null
  return {
    albumId: row.albumId, provider: row.provider, providerId: row.providerId || null, url: row.url || null,
    width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height),
    confidence: row.confidence == null ? null : Number(row.confidence), source: row.source,
    providerAlbum: row.providerAlbum || null, providerArtist: row.providerArtist || null, storeUrl: row.storeUrl || null, updatedAt: row.updatedAt || null,
  }
}

async function ensureAlbumArtworkTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS album_artwork (album_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT, url TEXT, width INTEGER, height INTEGER, confidence INTEGER, source TEXT NOT NULL, provider_album TEXT, provider_artist TEXT, store_url TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT)").run()
}

const albumArtworkColumns = 'album_id AS albumId, provider, provider_id AS providerId, url, width, height, confidence, source, provider_album AS providerAlbum, provider_artist AS providerArtist, store_url AS storeUrl, updated_at AS updatedAt'

async function selectAlbumArtwork(db, albumId) {
  return albumArtworkRow(await db.prepare('SELECT ' + albumArtworkColumns + ' FROM album_artwork WHERE album_id = ?').bind(albumId).first())
}

async function saveAlbumArtwork(db, albumId, artwork, source, username) {
  await db.prepare('INSERT INTO album_artwork (album_id, provider, provider_id, url, width, height, confidence, source, provider_album, provider_artist, store_url, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET provider = excluded.provider, provider_id = excluded.provider_id, url = excluded.url, width = excluded.width, height = excluded.height, confidence = excluded.confidence, source = excluded.source, provider_album = excluded.provider_album, provider_artist = excluded.provider_artist, store_url = excluded.store_url, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
    .bind(albumId, artwork.provider, artwork.providerId || null, artwork.url || null, Number(artwork.width) || null, Number(artwork.height) || null, artwork.confidence == null ? null : Math.round(Number(artwork.confidence)) || null, source, artwork.album ? String(artwork.album).slice(0, 240) : null, artwork.artist ? String(artwork.artist).slice(0, 240) : null, /^https:\/\/open\.spotify\.com\//.test(String(artwork.storeUrl || '')) ? artwork.storeUrl : null, username).run()
  return selectAlbumArtwork(db, albumId)
}

async function searchSpotifyAlbums(env, query) {
  const token = await spotifyAccessToken(env)
  if (!token) throw Object.assign(new Error('Spotify rejected the server credentials.'), { code: 'spotify-auth-failed' })
  const url = new URL('https://api.spotify.com/v1/search')
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'album')
  url.searchParams.set('limit', '10')
  url.searchParams.set('market', String(env.SPOTIFY_MARKET || 'GB').slice(0, 2).toUpperCase())
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
  if (response.status === 429) throw Object.assign(new Error('Spotify is rate limiting Tomify.'), { code: 'spotify-rate-limited', retryAfter: Math.min(120, Math.max(1, Number(response.headers.get('retry-after')) || 5)) })
  if (response.status === 401) spotifyTokenCache = null
  if (!response.ok) throw Object.assign(new Error('Spotify search returned HTTP ' + response.status + '.'), { code: 'spotify-error' })
  const body = await response.json()
  return Array.isArray(body?.albums?.items) ? body.albums.items.filter(Boolean) : []
}

async function lookupAlbumArtwork(env, db, album) {
  const releaseDate = (await selectRelease(db, album.albumId))?.releaseDate || (album.year ? String(album.year) : null)
  const wanted = { artist: album.artist, album: cleanReleaseTitle(album.name), releaseDate }
  for (const query of albumArtworkSearchQueries(wanted.album, wanted.artist)) {
    const items = await searchSpotifyAlbums(env, query)
    const candidates = rankArtworkCandidates(items.map((item) => spotifyAlbumCandidate(wanted, item, metadataTextSimilarity, artworkYearScore)).filter(Boolean)).slice(0, 6)
    if (candidates.length) return candidates
  }
  return []
}

async function handleAlbumArtworkRequest(request, env, url) {
  if (url.pathname !== '/api/album-artwork' && !url.pathname.startsWith('/api/album-artwork/')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'artwork-store-unavailable' }, 503)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  const db = env.TOMIFY_DB
  await ensureAlbumArtworkTable(db)

  if (url.pathname === '/api/album-artwork' && request.method === 'GET') {
    const rows = await db.prepare('SELECT ' + albumArtworkColumns + ' FROM album_artwork ORDER BY album_id').all()
    return json({ items: (rows.results || []).map(albumArtworkRow), spotifyAvailable: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) })
  }

  if (request.method !== 'POST') return json({ error: 'not-found' }, 404)
  const body = await request.json().catch(() => null)
  const albumId = typeof body?.albumId === 'string' ? body.albumId.trim().slice(0, 200) : ''
  if (!albumId) return json({ error: 'invalid-album' }, 400)

  if (url.pathname === '/api/album-artwork/lookup' || url.pathname === '/api/album-artwork/auto') {
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return json({ error: 'spotify-unavailable', message: 'Spotify is not configured on the server.' }, 503)
    const album = { albumId, name: String(body.name || '').slice(0, 240), artist: String(body.artist || '').slice(0, 240), year: Number(body.year) || null }
    if (!album.name || !album.artist) return json({ error: 'invalid-album' }, 400)
    await ensureReleaseTable(db)
    const existing = await selectAlbumArtwork(db, albumId)
    // A person's own choice, including keeping the library image, is never replaced automatically.
    if (url.pathname === '/api/album-artwork/auto' && existing?.source === 'manual') return json({ item: existing, applied: false, reason: 'manual-choice' })
    let candidates
    try { candidates = await lookupAlbumArtwork(env, db, album) }
    catch (error) {
      if (error?.code === 'spotify-rate-limited') return json({ error: error.code, message: 'Spotify asked Tomify to slow down.', retryAfter: error.retryAfter }, 429)
      return json({ error: error?.code || 'spotify-unavailable', message: error?.code ? error.message : 'Spotify could not be reached. Try again shortly.' }, 502)
    }
    if (url.pathname === '/api/album-artwork/lookup') return json({ candidates, item: existing })
    const chosen = chooseAutomaticAlbumArtwork(candidates)
    if (!chosen) return json({ item: existing, applied: false, reason: candidates.length ? 'low-confidence' : 'no-match' })
    if (existing?.url === chosen.url) return json({ item: existing, applied: false, reason: 'unchanged' })
    return json({ item: await saveAlbumArtwork(db, albumId, chosen, 'auto', username), applied: true })
  }

  if (url.pathname === '/api/album-artwork/select') {
    if (body.provider === 'library') return json({ item: await saveAlbumArtwork(db, albumId, { provider: 'library' }, 'manual', username) })
    const candidate = body.candidate
    if (candidate?.provider !== 'spotify' || !isAlbumArtworkUrl(candidate.url)) return json({ error: 'invalid-artwork', message: 'Only Spotify artwork can be selected.' }, 400)
    return json({ item: await saveAlbumArtwork(db, albumId, candidate, 'manual', username) })
  }

  if (url.pathname === '/api/album-artwork/reset') {
    await db.prepare('DELETE FROM album_artwork WHERE album_id = ?').bind(albumId).run()
    return json({ item: null })
  }

  return json({ error: 'not-found' }, 404)
}

export const albumArtworkWorkerSource = `const albumArtworkHosts = ${JSON.stringify(albumArtworkHosts)}\nconst albumArtworkColumns = ${JSON.stringify(albumArtworkColumns)}\n\n` + [isAlbumArtworkUrl, baseAlbumTitle, albumArtworkSearchQueries, spotifyAlbumCandidate, chooseAutomaticAlbumArtwork, albumArtworkRow, ensureAlbumArtworkTable, selectAlbumArtwork, saveAlbumArtwork, searchSpotifyAlbums, lookupAlbumArtwork, handleAlbumArtworkRequest].map((fn) => fn.toString()).join('\n\n')
