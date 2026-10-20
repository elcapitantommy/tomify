// Album artwork overrides: looks up catalogue artwork (Apple, then Deezer, then Spotify when
// it is configured and permitted) for albums already in the Navidrome library and stores the
// chosen image URL per album in D1. Navidrome's own files are never touched; Tomify shows the
// override instead of getCoverArt wherever it draws that album. The pure helpers are exported
// for tests; handleAlbumArtworkRequest relies on Worker globals (authenticate, json,
// spotifyAccessToken, spotifyTokenCache, spotifyUserToken, rankArtworkCandidates,
// metadataTextSimilarity, artworkYearScore, cleanReleaseTitle, selectRelease).

import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { metadataTextSimilarity } from '../../scripts/recovery-metadata.mjs'
import { rankArtworkCandidates } from '../../scripts/recovery-artwork.mjs'
import { spotifyUserToken } from './catalogue.ts'
import { artworkYearScore, cleanReleaseTitle, resetSpotifyTokenCache, selectRelease, spotifyAccessToken } from '../routes/recovery.ts'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env.ts'
import type { OpenJson } from '../routes/recovery.ts'

// The catalogue search result fields read here.
interface SpotifyAlbum { id?: string; name?: string; release_date?: string; artists?: Array<{ name?: string } | null>; images?: Array<{ url: string; width?: number; height?: number }>; external_urls?: { spotify?: string } }
interface AppleAlbum { collectionId?: number | string | null; collectionName?: string; artistName?: string; releaseDate?: string; artworkUrl100?: string; collectionViewUrl?: string }
interface DeezerAlbum { id?: number | string | null; title?: string; artist?: { name?: string }; release_date?: string; cover_xl?: string; link?: string }
type AlbumSearchResult = ReturnType<typeof spotifyAlbumResult> | ReturnType<typeof appleAlbumResult> | ReturnType<typeof deezerAlbumResult>
interface WantedAlbum { artist: string; album: string; releaseDate?: string | null }
interface AlbumArtworkRow {
  albumId: string; provider: string; providerId: string | null; url: string | null; width: number | null; height: number | null; confidence: number | null; source: string
  providerAlbum: string | null; providerArtist: string | null; storeUrl: string | null; updatedAt: string | null
}
// A chosen image: a scored candidate, an upload, or the library's own artwork.
interface AlbumArtworkChoice { provider: string; providerId?: string | null; url?: string | null; width?: unknown; height?: unknown; confidence?: unknown; album?: unknown; artist?: unknown; storeUrl?: unknown }

export const albumArtworkHosts = ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com']
export const albumArtworkHostSuffixes = ['.mzstatic.com', '.dzcdn.net']
export const albumArtworkProviders = ['apple', 'deezer', 'spotify']

export function isAlbumArtworkUrl(value: unknown) {
  try {
    const url = new URL(String(value || ''))
    const hostname = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (albumArtworkHosts.includes(hostname) || albumArtworkHostSuffixes.some((suffix) => hostname.endsWith(suffix)))
  } catch {
    return false
  }
}

// Catalogues often name the edition ("Abbey Road (Remastered 2009)", "Flood - Deluxe Edition")
// while a library folder does not, or the other way round, so titles are also compared
// with trailing bracketed or dashed edition qualifiers removed. Disc markers from albums split
// per disc ("The Essential Roy Orbison - Disc 2", "White Album CD1", "Flood, Disc One") go too,
// because catalogues list the whole release under its plain title.
const discNumberWords = 'one|two|three|four|five|six|seven|eight|nine|ten'
const trailingDiscPattern = new RegExp(`(?:\\s+|\\s*[-\u2013\u2014:,]\\s*)(?:disc|disk|cd)\\s*(?:\\d+|${discNumberWords})(?:\\s*(?:of|/)\\s*\\d+)?\\s*$`, 'i')

export function baseAlbumTitle(name: unknown) {
  const original = String(name || '').trim()
  let title = original
  let previous = ''
  while (title && title !== previous) {
    previous = title
    title = title.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '').trim()
    title = title.replace(trailingDiscPattern, '').trim()
    title = title.replace(/\s+[-\u2013\u2014]\s+[^-\u2013\u2014]*\b(?:remaster\w*|deluxe|edition|expanded|anniversary|reissue|version|mono|stereo|bonus)\b[^-\u2013\u2014]*$/i, '').trim()
  }
  return title || original
}

export function albumArtworkSearchQueries(album: unknown, artist: unknown) {
  const base = baseAlbumTitle(album)
  return [...new Set([`album:${base} artist:${artist}`, `${base} ${artist}`])]
}

// Each catalogue's search result is mapped to one shape before scoring.
export function spotifyAlbumResult(album: SpotifyAlbum | null | undefined) {
  const image = (Array.isArray(album?.images) ? album.images : []).slice().sort((left, right) => Number(right.width || 0) - Number(left.width || 0))[0]
  return { provider: 'spotify', providerLabel: 'Spotify', id: album?.id, name: album?.name, artists: (Array.isArray(album?.artists) ? album.artists : []).map((artist) => artist?.name), releaseDate: album?.release_date, image: image ? { url: image.url, width: image.width, height: image.height } : null, storeUrl: album?.external_urls?.spotify }
}

// Apple serves any size up to the original from the same path, so the 100px search thumbnail is rewritten to 1200px.
export function appleAlbumResult(result: AppleAlbum | null | undefined) {
  const thumbnail = String(result?.artworkUrl100 || '')
  const url = thumbnail.replace(/^http:/, 'https:').replace(/\d+x\d+(?=[^/]*\.(?:jpg|jpeg|png|webp)(?:\?|$))/i, '1200x1200')
  return { provider: 'apple', providerLabel: 'Apple', id: result?.collectionId == null ? null : String(result.collectionId), name: result?.collectionName, artists: [result?.artistName], releaseDate: result?.releaseDate, image: thumbnail ? { url, width: 1200, height: 1200 } : null, storeUrl: result?.collectionViewUrl }
}

export function deezerAlbumResult(album: DeezerAlbum | null | undefined) {
  return { provider: 'deezer', providerLabel: 'Deezer', id: album?.id == null ? null : String(album.id), name: album?.title, artists: [album?.artist?.name], releaseDate: album?.release_date, image: album?.cover_xl ? { url: album.cover_xl, width: 1000, height: 1000 } : null, storeUrl: album?.link }
}

// Scores one mapped search result against a library album. `similarity` and `yearScore`
// are the Worker's metadataTextSimilarity and artworkYearScore.
export function albumArtworkCandidate(wanted: WantedAlbum, result: AlbumSearchResult | null | undefined, similarity: (left: unknown, right: unknown) => number, yearScore: (expected: unknown, actual: unknown) => number) {
  const artists = (Array.isArray(result?.artists) ? result.artists : []).filter(Boolean)
  if (!result?.id || !artists.length) return null
  const artistSimilarity = Math.max(similarity(wanted.artist, artists.join(' ')), ...artists.map((name) => similarity(wanted.artist, name)))
  // An exact edition match ranks slightly above a match on the base title alone.
  const albumSimilarity = Math.max(similarity(wanted.album, result.name), similarity(baseAlbumTitle(wanted.album), baseAlbumTitle(result.name)) * 0.96)
  if (artistSimilarity < 0.82 || albumSimilarity < 0.8 || !isAlbumArtworkUrl(result.image?.url)) return null
  const confidence = Math.round(artistSimilarity * 50 + albumSimilarity * 40 + yearScore(wanted.releaseDate, result.releaseDate) * 10)
  return { id: result.provider + ':' + result.id, provider: result.provider, providerLabel: result.providerLabel, providerId: result.id, url: result.image!.url, previewUrl: result.image!.url, width: Number(result.image!.width) || null, height: Number(result.image!.height) || null, confidence, artist: artists.join(', '), album: result.name || null, releaseDate: result.releaseDate || null, storeUrl: result.storeUrl || null, selectable: true, unavailableReason: null }
}

// Automatic replacement only takes a confident, clean square catalogue image of at least 600px.
// Anything weaker is left for the album page, where a person can pick or decline it.
export function chooseAutomaticAlbumArtwork(candidates: OpenJson[] | null | undefined, minimumConfidence = 85) {
  return (Array.isArray(candidates) ? candidates : []).find((candidate) =>
    albumArtworkProviders.includes(candidate?.provider) && isAlbumArtworkUrl(candidate.url) && candidate.square && Number(candidate.minimumDimension || 0) >= 600 && Number(candidate.confidence || 0) >= minimumConfidence) || null
}

// Images an administrator uploads from their device are stored in D1 (capped well under D1's
// 2 MB value limit; the PWA shrinks them to at most 1200px JPEG first) and served from
// /api/album-artwork/image/<id>. Only JPEG, PNG and WebP are accepted, checked by file signature.
export const albumArtworkUploadMaxBytes = 1_000_000

export function decodeAlbumArtworkUpload(dataUrl: unknown): { error?: string; contentType?: string; base64?: string; size?: number } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''))
  if (!match) return { error: 'Upload a JPEG, PNG or WebP image.' }
  let binary
  try { binary = atob(match[2]) } catch { return { error: 'The image could not be read.' } }
  if (binary.length > albumArtworkUploadMaxBytes) return { error: 'The image is too large; upload one under 1 MB.' }
  const bytes = Array.from(binary.slice(0, 12), (character: string) => character.charCodeAt(0))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes[0] === 0x89 && binary.slice(1, 4) === 'PNG'
  const webp = binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP'
  const detected = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null
  if (!detected || detected !== match[1]) return { error: 'The file is not a JPEG, PNG or WebP image.' }
  return { contentType: detected, base64: match[2], size: binary.length }
}

export function albumArtworkRow(row: AlbumArtworkRow | null | undefined) {
  if (!row) return null
  return {
    albumId: row.albumId, provider: row.provider, providerId: row.providerId || null, url: row.url || null,
    width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height),
    confidence: row.confidence == null ? null : Number(row.confidence), source: row.source,
    providerAlbum: row.providerAlbum || null, providerArtist: row.providerArtist || null, storeUrl: row.storeUrl || null, updatedAt: row.updatedAt || null,
  }
}


const albumArtworkColumns = 'album_id AS albumId, provider, provider_id AS providerId, url, width, height, confidence, source, provider_album AS providerAlbum, provider_artist AS providerArtist, store_url AS storeUrl, updated_at AS updatedAt'


// Uploaded images no longer chosen for their album are removed so D1 only holds the current one.
async function pruneAlbumArtworkUploads(db: D1Database, albumId: string, keepId: string | null) {
  await db.prepare('DELETE FROM album_artwork_uploads WHERE album_id = ? AND id != ?').bind(albumId, keepId || '').run()
}

async function selectAlbumArtwork(db: D1Database, albumId: string) {
  return albumArtworkRow(await db.prepare('SELECT ' + albumArtworkColumns + ' FROM album_artwork WHERE album_id = ?').bind(albumId).first<AlbumArtworkRow>())
}

async function saveAlbumArtwork(db: D1Database, albumId: string, artwork: AlbumArtworkChoice, source: 'auto' | 'manual', username: string) {
  await db.prepare('INSERT INTO album_artwork (album_id, provider, provider_id, url, width, height, confidence, source, provider_album, provider_artist, store_url, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET provider = excluded.provider, provider_id = excluded.provider_id, url = excluded.url, width = excluded.width, height = excluded.height, confidence = excluded.confidence, source = excluded.source, provider_album = excluded.provider_album, provider_artist = excluded.provider_artist, store_url = excluded.store_url, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
    .bind(albumId, artwork.provider, artwork.providerId || null, artwork.url || null, Number(artwork.width) || null, Number(artwork.height) || null, artwork.confidence == null ? null : Math.round(Number(artwork.confidence)) || null, source, artwork.album ? String(artwork.album).slice(0, 240) : null, artwork.artist ? String(artwork.artist).slice(0, 240) : null, /^https:\/\/(?:open\.spotify\.com|music\.apple\.com|www\.deezer\.com)\//.test(String(artwork.storeUrl || '')) ? artwork.storeUrl : null, username).run()
  return selectAlbumArtwork(db, albumId)
}

// Spotify's 2026 Development Mode rules can refuse app-only (client credentials) tokens for
// search, so the connected Spotify account from playlist import is preferred when there is one.
async function spotifySearchToken(env: Env, db: D1Database, username: string, forceRefresh: boolean) {
  try { return { token: await spotifyUserToken(env, db, username, forceRefresh), account: true } }
  catch { /* not connected, or token storage unavailable */ }
  const token = await spotifyAccessToken(env)
  if (!token) throw Object.assign(new Error('Spotify rejected the server credentials.'), { code: 'spotify-auth-failed' })
  return { token, account: false }
}

async function searchSpotifyAlbums(env: Env, db: D1Database, username: string, query: string, refreshed = false): Promise<SpotifyAlbum[]> {
  const { token, account } = await spotifySearchToken(env, db, username, refreshed)
  const url = new URL('https://api.spotify.com/v1/search')
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'album')
  url.searchParams.set('limit', '10')
  url.searchParams.set('market', String(env.SPOTIFY_MARKET || 'GB').slice(0, 2).toUpperCase())
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
  if (response.status === 429) throw Object.assign(new Error('Spotify is rate limiting Tomify.'), { code: 'spotify-rate-limited', retryAfter: Math.min(120, Math.max(1, Number(response.headers.get('retry-after')) || 5)) })
  if (response.status === 401 && !refreshed) { if (!account) resetSpotifyTokenCache(); return searchSpotifyAlbums(env, db, username, query, true) }
  const body: OpenJson = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? ': ' + body.error.message.slice(0, 200).replace(/[.\s]+$/, '') : ''
    const hint = response.status === 403 ? (account ? ' Since March 2026 Spotify refuses Development Mode apps whose owner has no Premium subscription.' : ' Connect Spotify under Playlists > Import so Tomify can search as your account.') : ''
    throw Object.assign(new Error('Spotify search returned HTTP ' + response.status + detail + '.' + hint), { code: response.status === 403 ? 'spotify-forbidden' : 'spotify-error' })
  }
  return Array.isArray(body?.albums?.items) ? body.albums.items.filter(Boolean) : []
}

async function searchAppleAlbums(env: Env, wanted: WantedAlbum) {
  const url = new URL('https://itunes.apple.com/search')
  url.searchParams.set('term', baseAlbumTitle(wanted.album) + ' ' + wanted.artist)
  url.searchParams.set('media', 'music')
  url.searchParams.set('entity', 'album')
  url.searchParams.set('limit', '25')
  url.searchParams.set('country', String(env.APPLE_CATALOGUE_COUNTRY || 'GB').slice(0, 2).toUpperCase())
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  // Apple allows roughly 20 searches a minute and answers 403 or 429 beyond that.
  if (response.status === 403 || response.status === 429) throw Object.assign(new Error('Apple is rate limiting Tomify.'), { code: 'rate-limited', retryAfter: 60 })
  if (!response.ok) throw Object.assign(new Error('Apple search returned HTTP ' + response.status + '.'), { code: 'apple-error' })
  const body: OpenJson = await response.json().catch(() => null)
  return (Array.isArray(body?.results) ? body.results : []).map(appleAlbumResult)
}

async function searchDeezerAlbums(env: Env, wanted: WantedAlbum) {
  const base = baseAlbumTitle(wanted.album)
  for (const query of [`artist:"${wanted.artist.replace(/"/g, '')}" album:"${base.replace(/"/g, '')}"`, `${base} ${wanted.artist}`]) {
    const url = new URL('https://api.deezer.com/search/album')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '25')
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (response.status === 429) throw Object.assign(new Error('Deezer is rate limiting Tomify.'), { code: 'rate-limited', retryAfter: 5 })
    if (!response.ok) throw Object.assign(new Error('Deezer search returned HTTP ' + response.status + '.'), { code: 'deezer-error' })
    const body: OpenJson = await response.json().catch(() => null)
    // Deezer reports its quota as an error object inside a 200 response.
    if (body?.error) throw Object.assign(new Error('Deezer search failed: ' + String(body.error.message || body.error.type || 'unknown error').slice(0, 200)), body.error.code === 4 ? { code: 'rate-limited', retryAfter: 5 } : { code: 'deezer-error' })
    const results = (Array.isArray(body?.data) ? body.data : []).map(deezerAlbumResult)
    if (results.length) return results
  }
  return []
}

async function searchSpotifyArtwork(env: Env, db: D1Database, username: string, wanted: WantedAlbum) {
  for (const query of albumArtworkSearchQueries(wanted.album, wanted.artist)) {
    const results = (await searchSpotifyAlbums(env, db, username, query)).map(spotifyAlbumResult)
    if (results.length) return results
  }
  return []
}

// Providers are tried in order. A provider that fails is skipped while another still
// answers; only when every provider fails is the error reported, a rate limit first.
// `report`, when given, records which catalogues answered and why any failed, so the album
// page can say "Spotify could not be searched: ..." instead of a bare "no match".
export interface AlbumArtworkLookupReport { query: { album: string; artist: string } | null; searched: string[]; failed: Array<{ provider: string; message: string }> }
async function lookupAlbumArtwork(env: Env, db: D1Database, username: string, album: { albumId: string; name: string; artist: string; year: number | null }, { stopAtConfident = false } = {}, report?: AlbumArtworkLookupReport) {
  const releaseDate = (await selectRelease(db, album.albumId))?.releaseDate || (album.year ? String(album.year) : null)
  const wanted = { artist: album.artist, album: cleanReleaseTitle(album.name), releaseDate }
  if (report) report.query = { album: baseAlbumTitle(wanted.album), artist: wanted.artist }
  const searches: Array<{ provider: string; run: () => Promise<AlbumSearchResult[]> }> = [{ provider: 'apple', run: () => searchAppleAlbums(env, wanted) }, { provider: 'deezer', run: () => searchDeezerAlbums(env, wanted) }]
  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) searches.push({ provider: 'spotify', run: () => searchSpotifyArtwork(env, db, username, wanted) })
  let candidates: OpenJson[] = []
  const errors: OpenJson[] = []
  for (const search of searches) {
    try {
      const found = (await search.run()).map((result) => albumArtworkCandidate(wanted, result, metadataTextSimilarity, artworkYearScore)).filter(Boolean)
      candidates = rankArtworkCandidates([...candidates, ...found]).slice(0, 6)
      report?.searched.push(search.provider)
    } catch (error: OpenJson) {
      errors.push(error)
      report?.failed.push({ provider: search.provider, message: String(error?.message || 'Search failed.').slice(0, 400) })
    }
    if (stopAtConfident && chooseAutomaticAlbumArtwork(candidates)) break
  }
  if (!candidates.length && errors.length === searches.length) {
    // When every catalogue is rate limiting, retry as soon as the first one allows it.
    const limited = errors.filter((error) => error?.code === 'rate-limited' || error?.code === 'spotify-rate-limited')
    if (limited.length === errors.length) throw Object.assign(new Error(limited.map((error) => error.message).join(' ')), { code: 'rate-limited', retryAfter: Math.min(...limited.map((error) => Number(error.retryAfter) || 5)) })
    throw Object.assign(new Error(errors.map((error) => error?.message || 'Search failed.').join(' ')), { code: errors.find((error) => error?.code && !String(error.code).includes('rate-limited'))?.code || 'artwork-unavailable' })
  }
  return candidates
}

export async function handleAlbumArtworkRequest(request: Request, env: Env, url: URL) {
  if (url.pathname !== '/api/album-artwork' && !url.pathname.startsWith('/api/album-artwork/')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'artwork-store-unavailable' }, 503)
  const db = env.TOMIFY_DB
  // Uploaded covers are drawn by <img> tags, which cannot send Tomify's auth headers, so the
  // image itself is public; its id is random and changes with every upload.
  const imageMatch = /^\/api\/album-artwork\/image\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (imageMatch && request.method === 'GET') {
    const image = await db.prepare('SELECT content_type AS contentType, data FROM album_artwork_uploads WHERE id = ?').bind(imageMatch[1]).first<{ contentType: string; data: string }>()
    if (!image) return json({ error: 'not-found' }, 404)
    const binary = atob(image.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Response(bytes, { headers: { 'content-type': image.contentType, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } })
  }
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)

  if (url.pathname === '/api/album-artwork' && request.method === 'GET') {
    const rows = await db.prepare('SELECT ' + albumArtworkColumns + ' FROM album_artwork ORDER BY album_id').all<AlbumArtworkRow>()
    return json({ items: (rows.results || []).map(albumArtworkRow), providers: env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? albumArtworkProviders : albumArtworkProviders.filter((provider) => provider !== 'spotify') })
  }

  if (request.method !== 'POST') return json({ error: 'not-found' }, 404)
  // Everyone sees the chosen artwork; only administrators can look up, change or reset it.
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can change album artwork.' }, 403)
  const body: OpenJson = await request.json().catch(() => null)
  const albumId = typeof body?.albumId === 'string' ? body.albumId.trim().slice(0, 200) : ''
  if (!albumId) return json({ error: 'invalid-album' }, 400)

  if (url.pathname === '/api/album-artwork/lookup' || url.pathname === '/api/album-artwork/auto') {
    const album = { albumId, name: String(body.name || '').slice(0, 240), artist: String(body.artist || '').slice(0, 240), year: Number(body.year) || null }
    if (!album.name || !album.artist) return json({ error: 'invalid-album' }, 400)
    const existing = await selectAlbumArtwork(db, albumId)
    // A person's own choice, including keeping the library image, is never replaced automatically.
    if (url.pathname === '/api/album-artwork/auto' && existing?.source === 'manual') return json({ item: existing, applied: false, reason: 'manual-choice' })
    let candidates: OpenJson[]
    const report: AlbumArtworkLookupReport = { query: null, searched: [], failed: [] }
    try { candidates = await lookupAlbumArtwork(env, db, username, album, { stopAtConfident: url.pathname === '/api/album-artwork/auto' }, report) }
    catch (error: OpenJson) {
      if (error?.code === 'rate-limited' || error?.code === 'spotify-rate-limited') return json({ error: 'rate-limited', message: error.message, retryAfter: error.retryAfter }, 429)
      return json({ error: error?.code || 'artwork-unavailable', message: error?.code ? error.message : 'Artwork catalogues could not be reached. Try again shortly.' }, 502)
    }
    if (url.pathname === '/api/album-artwork/lookup') return json({ candidates, item: existing, ...report })
    const chosen = chooseAutomaticAlbumArtwork(candidates)
    if (!chosen) return json({ item: existing, applied: false, reason: candidates.length ? 'low-confidence' : 'no-match' })
    if (existing?.url === chosen.url) return json({ item: existing, applied: false, reason: 'unchanged' })
    return json({ item: await saveAlbumArtwork(db, albumId, chosen, 'auto', username), applied: true })
  }

  if (url.pathname === '/api/album-artwork/upload') {
    const upload = decodeAlbumArtworkUpload(body.image)
    if (upload.error) return json({ error: 'invalid-image', message: upload.error }, 400)
    const id = crypto.randomUUID()
    await db.prepare('INSERT INTO album_artwork_uploads (id, album_id, content_type, data, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, albumId, upload.contentType, upload.base64, upload.size, username).run()
    const item = await saveAlbumArtwork(db, albumId, { provider: 'upload', providerId: id, url: '/api/album-artwork/image/' + id, width: Math.round(Number(body.width)) || null, height: Math.round(Number(body.height)) || null }, 'manual', username)
    await pruneAlbumArtworkUploads(db, albumId, id)
    return json({ item }, 201)
  }

  if (url.pathname === '/api/album-artwork/select') {
    if (body.provider === 'library') {
      const item = await saveAlbumArtwork(db, albumId, { provider: 'library' }, 'manual', username)
      await pruneAlbumArtworkUploads(db, albumId, null)
      return json({ item })
    }
    const candidate = body.candidate
    if (!albumArtworkProviders.includes(candidate?.provider) || !isAlbumArtworkUrl(candidate.url)) return json({ error: 'invalid-artwork', message: 'Only Apple, Deezer or Spotify artwork can be selected.' }, 400)
    const item = await saveAlbumArtwork(db, albumId, candidate, 'manual', username)
    await pruneAlbumArtworkUploads(db, albumId, null)
    return json({ item })
  }

  if (url.pathname === '/api/album-artwork/reset') {
    await db.prepare('DELETE FROM album_artwork WHERE album_id = ?').bind(albumId).run()
    await pruneAlbumArtworkUploads(db, albumId, null)
    return json({ item: null })
  }

  return json({ error: 'not-found' }, 404)
}

export { lookupAlbumArtwork }
