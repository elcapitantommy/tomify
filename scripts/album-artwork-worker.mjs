// Album artwork overrides: looks up Spotify artwork for albums already in the Navidrome
// library and stores the chosen image per album in D1. Navidrome's own files are never
// touched; Tomify shows the override instead of getCoverArt wherever it draws that album.
// The pure helpers are exported for tests; handleAlbumArtworkRequest relies on Worker
// globals (authenticate, json, spotifyArtworkCandidates, rankArtworkCandidates,
// cleanReleaseTitle, selectRelease, ensureReleaseTable).

export const albumArtworkHosts = ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com']

export function isAlbumArtworkUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && albumArtworkHosts.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

// Library folders often carry edition or remaster suffixes that Spotify spells differently,
// so a second search drops trailing bracketed qualifiers before giving up.
export function albumArtworkSearchTitles(name) {
  const original = String(name || '').trim()
  const stripped = original.replace(/(?:\s*[([][^()[\]]*[)\]])+\s*$/g, '').trim()
  return [...new Set([original, stripped].filter(Boolean))]
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

async function lookupAlbumArtwork(env, db, album) {
  const releaseDate = (await selectRelease(db, album.albumId))?.releaseDate || (album.year ? String(album.year) : null)
  for (const title of albumArtworkSearchTitles(cleanReleaseTitle(album.name))) {
    const candidates = rankArtworkCandidates((await spotifyArtworkCandidates(env, { artist: album.artist, album: title, releaseDate })).filter((candidate) => isAlbumArtworkUrl(candidate.url))).slice(0, 6)
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
    catch { return json({ error: 'spotify-unavailable', message: 'Spotify could not be reached. Try again shortly.' }, 502) }
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

export const albumArtworkWorkerSource = `const albumArtworkHosts = ${JSON.stringify(albumArtworkHosts)}\nconst albumArtworkColumns = ${JSON.stringify(albumArtworkColumns)}\n\n` + [isAlbumArtworkUrl, albumArtworkSearchTitles, chooseAutomaticAlbumArtwork, albumArtworkRow, ensureAlbumArtworkTable, selectAlbumArtwork, saveAlbumArtwork, lookupAlbumArtwork, handleAlbumArtworkRequest].map((fn) => fn.toString()).join('\n\n')
