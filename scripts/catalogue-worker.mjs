function spotifyRedirectUri(env, request) {
  return String(env.SPOTIFY_REDIRECT_URI || new URL('/api/catalogue-auth/spotify/callback', request.url))
}

function bytesToBase64(bytes) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

function base64ToBytes(value) {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function catalogueTokenKey(env) {
  if (!env.SPOTIFY_TOKEN_ENCRYPTION_KEY) throw new Error('Spotify token encryption is not configured.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.SPOTIFY_TOKEN_ENCRYPTION_KEY)))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptCatalogueToken(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await catalogueTokenKey(env), new TextEncoder().encode(JSON.stringify(value)))
  return bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(encrypted))
}

async function decryptCatalogueToken(env, value) {
  const [iv, encrypted] = String(value || '').split('.')
  if (!iv || !encrypted) throw new Error('Stored Spotify authorization is invalid.')
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, await catalogueTokenKey(env), base64ToBytes(encrypted))
  return JSON.parse(new TextDecoder().decode(decrypted))
}

async function ensureCatalogueTables(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_playlists (id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, provider_playlist_id TEXT NOT NULL, source_url TEXT NOT NULL, snapshot_id TEXT, artwork_url TEXT, provenance_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, position INTEGER NOT NULL, provider_track_id TEXT, metadata_json TEXT NOT NULL, status TEXT NOT NULL, local_track_id TEXT, local_track_json TEXT, recovery_id TEXT, match_confidence INTEGER NOT NULL DEFAULT 0, user_confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_oauth_states (state TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_provider_tokens (username TEXT NOT NULL, provider TEXT NOT NULL, encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (username, provider))"),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_user ON catalogue_playlists(username, updated_at DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_source ON catalogue_playlists(username, provider, provider_playlist_id)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogue_playlist_position ON catalogue_playlist_items(playlist_id, position)'),
  ])
  try { await db.prepare('ALTER TABLE recovery_items ADD COLUMN source_json TEXT').run() } catch { /* column already exists */ }
}

async function spotifyTokenRequest(env, parameters) {
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa(String(env.SPOTIFY_CLIENT_ID) + ':' + String(env.SPOTIFY_CLIENT_SECRET)), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(parameters) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.access_token) throw new Error(body.error_description || body.error || 'Spotify authorization failed.')
  return body
}

async function spotifyUserToken(env, db, username, forceRefresh = false) {
  const row = await db.prepare("SELECT encrypted_token AS encryptedToken FROM catalogue_provider_tokens WHERE username = ? AND provider = 'spotify'").bind(username).first()
  if (!row?.encryptedToken) throw new Error('Connect Spotify before importing a playlist.')
  const stored = await decryptCatalogueToken(env, row.encryptedToken)
  if (!forceRefresh && Number(stored.expiresAt || 0) > Date.now() + 60_000) return stored.accessToken
  if (!stored.refreshToken) throw new Error('Spotify authorization has expired. Reconnect Spotify.')
  const refreshed = await spotifyTokenRequest(env, { grant_type: 'refresh_token', refresh_token: stored.refreshToken })
  const next = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || stored.refreshToken, expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000, scope: refreshed.scope || stored.scope || '' }
  await db.prepare("UPDATE catalogue_provider_tokens SET encrypted_token = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ? AND provider = 'spotify'").bind(await encryptCatalogueToken(env, next), username).run()
  return next.accessToken
}

async function spotifyApiJson(env, db, username, url, refreshed = false, rateRetried = false) {
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + await spotifyUserToken(env, db, username, refreshed), accept: 'application/json' } })
  if (response.status === 401 && !refreshed) return spotifyApiJson(env, db, username, url, true, rateRetried)
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 0)
    if (!rateRetried && retryAfter > 0 && retryAfter <= 3) { await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000)); return spotifyApiJson(env, db, username, url, refreshed, true) }
    throw new Error('Spotify is rate limiting playlist access. Try again shortly.')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(response.status === 403 ? 'Spotify only permits access to playlists owned by or shared collaboratively with the connected account.' : body.error?.message || 'Spotify playlist request failed.')
  return body
}

async function fetchSpotifyPlaylist(env, db, username, playlistId, sourceUrl) {
  const market = String(env.SPOTIFY_MARKET || 'GB').slice(0, 2).toUpperCase()
  const playlist = await spotifyApiJson(env, db, username, 'https://api.spotify.com/v1/playlists/' + encodeURIComponent(playlistId) + '?market=' + encodeURIComponent(market))
  const entries = []
  let next = 'https://api.spotify.com/v1/playlists/' + encodeURIComponent(playlistId) + '/items?limit=50&market=' + encodeURIComponent(market)
  while (next && entries.length < 10_000) {
    const nextUrl = new URL(next)
    if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'api.spotify.com') throw new Error('Spotify returned an unsafe pagination URL.')
    const page = await spotifyApiJson(env, db, username, nextUrl.toString())
    entries.push(...(Array.isArray(page.items) ? page.items : []))
    next = page.next || null
  }
  return mapSpotifyPlaylist(playlist, entries, sourceUrl)
}

function cataloguePlaylistRow(row) {
  let provenance = null
  try { provenance = row.provenanceJson ? JSON.parse(row.provenanceJson) : null } catch { provenance = null }
  return { id: row.id, name: row.name, provider: row.provider, providerPlaylistId: row.providerPlaylistId, sourceUrl: row.sourceUrl, snapshotId: row.snapshotId || null, artworkUrl: row.artworkUrl || null, createdAt: row.createdAt, updatedAt: row.updatedAt, counts: { total: Number(row.total || 0), available: Number(row.available || 0), missing: Number(row.missing || 0), review: Number(row.review || 0), unavailable: Number(row.unavailable || 0) }, provenance }
}

async function cataloguePlaylistDetail(db, username, id) {
  const row = await db.prepare("SELECT p.id, p.name, p.provider, p.provider_playlist_id AS providerPlaylistId, p.source_url AS sourceUrl, p.snapshot_id AS snapshotId, p.artwork_url AS artworkUrl, p.provenance_json AS provenanceJson, p.created_at AS createdAt, p.updated_at AS updatedAt, COUNT(i.id) AS total, SUM(CASE WHEN i.status = 'available' THEN 1 ELSE 0 END) AS available, SUM(CASE WHEN i.status = 'missing' THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN i.status = 'review' THEN 1 ELSE 0 END) AS review, SUM(CASE WHEN i.status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable FROM catalogue_playlists p LEFT JOIN catalogue_playlist_items i ON i.playlist_id = p.id WHERE p.id = ? AND p.username = ? GROUP BY p.id").bind(id, username).first()
  if (!row) return null
  const itemRows = await db.prepare('SELECT id, position, provider_track_id AS providerTrackId, metadata_json AS metadataJson, status, local_track_id AS localTrackId, local_track_json AS localTrackJson, recovery_id AS recoveryId, match_confidence AS matchConfidence, user_confirmed AS userConfirmed FROM catalogue_playlist_items WHERE playlist_id = ? ORDER BY position').bind(id).all()
  const items = (itemRows.results || []).map((item) => { let metadata = {}; let localTrack = null; try { metadata = JSON.parse(item.metadataJson) } catch {} try { localTrack = item.localTrackJson ? JSON.parse(item.localTrackJson) : null } catch {} return { id: item.id, position: Number(item.position), providerTrackId: item.providerTrackId || null, ...metadata, status: item.status, localTrackId: item.localTrackId || null, localTrack, recoveryId: item.recoveryId || null, matchConfidence: Number(item.matchConfidence || 0), userConfirmed: Boolean(item.userConfirmed) } })
  return { ...cataloguePlaylistRow(row), items }
}

async function saveCataloguePlaylist(db, username, draft, input) {
  if (!draft || draft.provider !== 'spotify' || !draft.providerPlaylistId || !Array.isArray(draft.items) || draft.items.length > 10_000) throw new Error('Invalid catalogue playlist payload.')
  const updating = input.mode === 'update' && typeof input.playlistId === 'string'
  const id = updating ? input.playlistId : crypto.randomUUID()
  let existingItems = []
  if (updating) {
    const existing = await cataloguePlaylistDetail(db, username, id)
    if (!existing || existing.provider !== draft.provider || existing.providerPlaylistId !== draft.providerPlaylistId) throw new Error('The playlist selected for update does not match this Spotify source.')
    existingItems = existing.items
  }
  const oldKeys = occurrenceKeys(existingItems)
  const retained = new Map(oldKeys.map((key, index) => [key, existingItems[index]]))
  const newKeys = occurrenceKeys(draft.items)
  const recoveryRows = input.createRecovery ? await db.prepare('SELECT id, artist, title, source_json AS sourceJson FROM recovery_items WHERE username = ?').bind(username).all() : { results: [] }
  const knownRecoveries = (recoveryRows.results || []).map((row) => { let catalogueSource = null; try { catalogueSource = row.sourceJson ? JSON.parse(row.sourceJson) : null } catch {} return { id: row.id, artist: row.artist, title: row.title, catalogueSource } })
  const newRecoveries = []
  const itemValues = []
  for (let index = 0; index < draft.items.length; index += 1) {
    const item = { ...draft.items[index], position: index }
    const previous = retained.get(newKeys[index])
    if (!item.localTrack && previous?.localTrack) { item.localTrack = previous.localTrack; item.localTrackId = previous.localTrackId; item.status = 'available'; item.matchConfidence = previous.matchConfidence; item.userConfirmed = previous.userConfirmed }
    let recoveryId = previous?.recoveryId || null
    if (!recoveryId && shouldCreateRecovery(item, input.createRecovery)) {
      recoveryId = reusableRecoveryId(item, knownRecoveries)
      if (!recoveryId) {
        recoveryId = crypto.randomUUID()
        const source = { catalogueSource: 'spotify', spotifyTrackId: item.providerTrackId || null, spotifyTrackUrl: item.sourceUrl || null, spotifyAlbumId: item.providerAlbumId || null, spotifyArtistIds: item.providerArtistIds || [], spotifyPlaylistId: draft.providerPlaylistId, spotifyPlaylistName: draft.name, spotifyPlaylistPosition: item.position, spotifyISRC: item.isrc || null, sourcePlaylistUrl: draft.sourceUrl, releaseDate: item.releaseDate || null, explicit: Boolean(item.explicit), artwork: item.artwork || [] }
        newRecoveries.push([recoveryId, username, (item.artists || []).join(', '), item.title, item.album || null, item.duration || null, item.trackNumber || null, item.discNumber || null, JSON.stringify(source)])
        knownRecoveries.push({ id: recoveryId, artist: (item.artists || []).join(', '), title: item.title, catalogueSource: source })
      }
    }
    const metadata = { providerAlbumId: item.providerAlbumId || null, providerArtistIds: item.providerArtistIds || [], title: item.title || 'Unavailable Spotify item', artists: item.artists || [], album: item.album || null, albumType: item.albumType || null, duration: item.duration || null, discNumber: item.discNumber || null, trackNumber: item.trackNumber || null, releaseDate: item.releaseDate || null, isrc: item.isrc || null, musicBrainzRecordingId: item.musicBrainzRecordingId || null, explicit: Boolean(item.explicit), artwork: item.artwork || [], sourceUrl: item.sourceUrl || null, unavailableReason: item.unavailableReason || null }
    itemValues.push([crypto.randomUUID(), id, index, item.providerTrackId || null, JSON.stringify(metadata), ['available', 'review', 'missing', 'unavailable'].includes(item.status) ? item.status : 'missing', item.localTrack?.id || item.localTrackId || null, item.localTrack ? JSON.stringify(item.localTrack) : null, recoveryId, Number(item.matchConfidence || 0), item.userConfirmed ? 1 : 0])
  }
  const statements = [db.prepare("INSERT INTO catalogue_playlists (id, username, name, provider, provider_playlist_id, source_url, snapshot_id, artwork_url, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, snapshot_id = excluded.snapshot_id, artwork_url = excluded.artwork_url, provenance_json = excluded.provenance_json, updated_at = CURRENT_TIMESTAMP").bind(id, username, String(draft.name || 'Spotify playlist').slice(0, 300), draft.provider, draft.providerPlaylistId, draft.sourceUrl, draft.snapshotId || null, draft.artwork?.[0]?.url || null, JSON.stringify({ importedAt: new Date().toISOString(), provider: draft.provider, sourceUrl: draft.sourceUrl }))]
  for (let offset = 0; offset < newRecoveries.length; offset += 10) {
    const values = newRecoveries.slice(offset, offset + 10)
    statements.push(db.prepare("INSERT INTO recovery_items (id, username, artist, title, album, duration, track_number, disc_number, source_json, status) VALUES " + values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')").join(', ')).bind(...values.flat()))
  }
  if (updating) statements.push(db.prepare('DELETE FROM catalogue_playlist_items WHERE playlist_id = ?').bind(id))
  for (let offset = 0; offset < itemValues.length; offset += 9) {
    const values = itemValues.slice(offset, offset + 9)
    statements.push(db.prepare('INSERT INTO catalogue_playlist_items (id, playlist_id, position, provider_track_id, metadata_json, status, local_track_id, local_track_json, recovery_id, match_confidence, user_confirmed) VALUES ' + values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')).bind(...values.flat()))
  }
  await db.batch(statements)
  return cataloguePlaylistDetail(db, username, id)
}

// Adding missing tracks to Recovery is for Navidrome administrators; anyone can import the playlist itself.
function recoveryForbidden() { return json({ error: 'forbidden', message: 'Only a Navidrome administrator can add tracks to Recovery. Import the playlist without Recovery instead.' }, 403) }

async function handleCatalogueRequest(request, env, url) {
  if (!url.pathname.startsWith('/api/catalogue-')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'catalogue-store-unavailable' }, 503)
  await ensureRecoveryTables(env.TOMIFY_DB)
  await ensureCatalogueTables(env.TOMIFY_DB)

  if (url.pathname === '/api/catalogue-auth/spotify/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const row = state ? await env.TOMIFY_DB.prepare('SELECT username, expires_at AS expiresAt FROM catalogue_oauth_states WHERE state = ?').bind(state).first() : null
    if (state) await env.TOMIFY_DB.prepare('DELETE FROM catalogue_oauth_states WHERE state = ?').bind(state).run()
    const redirect = new URL('/playlists/import/spotify', request.url)
    if (!row || Number(row.expiresAt) < Date.now() || !code || url.searchParams.get('error')) { redirect.searchParams.set('spotify', 'error'); return Response.redirect(redirect.toString(), 302) }
    try {
      const token = await spotifyTokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri(env, request) })
      const stored = { accessToken: token.access_token, refreshToken: token.refresh_token || null, expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000, scope: token.scope || '' }
      await env.TOMIFY_DB.prepare("INSERT INTO catalogue_provider_tokens (username, provider, encrypted_token) VALUES (?, 'spotify', ?) ON CONFLICT(username, provider) DO UPDATE SET encrypted_token = excluded.encrypted_token, updated_at = CURRENT_TIMESTAMP").bind(row.username, await encryptCatalogueToken(env, stored)).run()
      redirect.searchParams.set('spotify', 'connected')
    } catch { redirect.searchParams.set('spotify', 'error') }
    return Response.redirect(redirect.toString(), 302)
  }

  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  const configured = Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_TOKEN_ENCRYPTION_KEY)
  if (url.pathname === '/api/catalogue-auth/spotify/status' && request.method === 'GET') {
    const token = configured ? await env.TOMIFY_DB.prepare("SELECT updated_at AS updatedAt FROM catalogue_provider_tokens WHERE username = ? AND provider = 'spotify'").bind(username).first() : null
    return json({ configured, connected: Boolean(token), updatedAt: token?.updatedAt || null })
  }
  if (url.pathname === '/api/catalogue-auth/spotify/start' && request.method === 'POST') {
    if (!configured) return json({ error: 'spotify-not-configured', message: 'Spotify import is not configured on this Tomify server.' }, 503)
    const state = crypto.randomUUID().replace(/-/g, '')
    await env.TOMIFY_DB.prepare('DELETE FROM catalogue_oauth_states WHERE expires_at < ?').bind(Date.now()).run()
    await env.TOMIFY_DB.prepare('INSERT INTO catalogue_oauth_states (state, username, expires_at) VALUES (?, ?, ?)').bind(state, username, Date.now() + 10 * 60_000).run()
    const authorize = new URL('https://accounts.spotify.com/authorize')
    authorize.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID); authorize.searchParams.set('response_type', 'code'); authorize.searchParams.set('redirect_uri', spotifyRedirectUri(env, request)); authorize.searchParams.set('state', state); authorize.searchParams.set('scope', 'playlist-read-private playlist-read-collaborative')
    return json({ authorizationUrl: authorize.toString() })
  }
  if (url.pathname === '/api/catalogue-auth/spotify' && request.method === 'DELETE') {
    await env.TOMIFY_DB.prepare("DELETE FROM catalogue_provider_tokens WHERE username = ? AND provider = 'spotify'").bind(username).run(); return json({ disconnected: true })
  }
  if (url.pathname === '/api/catalogue-imports/spotify/analyse' && request.method === 'POST') {
    try {
      const input = await request.json(); const playlistId = parseSpotifyPlaylistId(input.url)
      if (!playlistId) return json({ error: 'invalid-spotify-playlist-url', message: 'Paste a complete Spotify playlist URL.' }, 400)
      const playlist = await fetchSpotifyPlaylist(env, env.TOMIFY_DB, username, playlistId, 'https://open.spotify.com/playlist/' + playlistId)
      const rows = await env.TOMIFY_DB.prepare("SELECT id FROM catalogue_playlists WHERE username = ? AND provider = 'spotify' AND provider_playlist_id = ? ORDER BY updated_at DESC").bind(username, playlistId).all()
      const existingPlaylists = []
      for (const row of rows.results || []) { const detail = await cataloguePlaylistDetail(env.TOMIFY_DB, username, row.id); if (detail) existingPlaylists.push(detail) }
      return json({ playlist, existingPlaylists, diff: existingPlaylists[0] ? diffCataloguePlaylist(existingPlaylists[0].items, playlist.items) : null })
    } catch (error) { return json({ error: 'spotify-playlist-unavailable', message: error instanceof Error ? error.message : 'Spotify playlist analysis failed.' }, 502) }
  }
  if (url.pathname === '/api/catalogue-playlists' && request.method === 'GET') {
    const rows = await env.TOMIFY_DB.prepare("SELECT p.id, p.name, p.provider, p.provider_playlist_id AS providerPlaylistId, p.source_url AS sourceUrl, p.snapshot_id AS snapshotId, p.artwork_url AS artworkUrl, p.provenance_json AS provenanceJson, p.created_at AS createdAt, p.updated_at AS updatedAt, COUNT(i.id) AS total, SUM(CASE WHEN i.status = 'available' THEN 1 ELSE 0 END) AS available, SUM(CASE WHEN i.status = 'missing' THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN i.status = 'review' THEN 1 ELSE 0 END) AS review, SUM(CASE WHEN i.status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable FROM catalogue_playlists p LEFT JOIN catalogue_playlist_items i ON i.playlist_id = p.id WHERE p.username = ? GROUP BY p.id ORDER BY p.updated_at DESC").bind(username).all()
    return json({ playlists: (rows.results || []).map(cataloguePlaylistRow) })
  }
  if (url.pathname === '/api/catalogue-playlists' && request.method === 'POST') {
    try { const input = await request.json(); if (input?.createRecovery && !(await isNavidromeAdmin(request, username))) return recoveryForbidden(); return json({ playlist: await saveCataloguePlaylist(env.TOMIFY_DB, username, input.playlist, input) }, 201) } catch (error) { return json({ error: 'catalogue-playlist-import-failed', message: error instanceof Error ? error.message : 'Playlist import failed.' }, 400) }
  }
  const match = url.pathname.match(/^\/api\/catalogue-playlists\/([^/]+)(?:\/(resolve))?$/)
  if (match && request.method === 'GET' && !match[2]) {
    const own = await cataloguePlaylistDetail(env.TOMIFY_DB, username, match[1])
    if (own) return json({ playlist: { ...own, owner: username, sharedWithMe: false } })
    // Another account's playlist is readable only when its owner shared it with this account.
    await ensurePlaylistShareTables(env.TOMIFY_DB)
    const share = await playlistShareFor(env.TOMIFY_DB, 'imported', match[1], username)
    const ownerRow = share ? await env.TOMIFY_DB.prepare('SELECT username FROM catalogue_playlists WHERE id = ?').bind(match[1]).first() : null
    const shared = ownerRow ? await cataloguePlaylistDetail(env.TOMIFY_DB, ownerRow.username, match[1]) : null
    return shared ? json({ playlist: { ...shared, owner: ownerRow.username, sharedWithMe: true } }) : json({ error: 'playlist-not-found' }, 404)
  }
  if (match && request.method === 'PUT' && !match[2]) {
    try { const input = await request.json(); if (input?.createRecovery && !(await isNavidromeAdmin(request, username))) return recoveryForbidden(); return json({ playlist: await saveCataloguePlaylist(env.TOMIFY_DB, username, input.playlist, { ...input, mode: 'update', playlistId: match[1] }) }) } catch (error) { return json({ error: 'catalogue-playlist-update-failed', message: error instanceof Error ? error.message : 'Playlist update failed.' }, 400) }
  }
  if (match && match[2] === 'resolve' && request.method === 'PATCH') {
    const owner = await env.TOMIFY_DB.prepare('SELECT id FROM catalogue_playlists WHERE id = ? AND username = ?').bind(match[1], username).first()
    if (!owner) return json({ error: 'playlist-not-found' }, 404)
    const input = await request.json(); const updates = Array.isArray(input.items) ? input.items.slice(0, 500) : []
    const statements = updates.filter((item) => item?.id && item?.localTrack?.id).map((item) => env.TOMIFY_DB.prepare("UPDATE catalogue_playlist_items SET status = 'available', local_track_id = ?, local_track_json = ?, match_confidence = ?, user_confirmed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND playlist_id = ?").bind(item.localTrack.id, JSON.stringify(item.localTrack), Number(item.matchConfidence || 0), item.userConfirmed ? 1 : 0, item.id, match[1]))
    for (let index = 0; index < statements.length; index += 75) await env.TOMIFY_DB.batch(statements.slice(index, index + 75))
    return json({ playlist: await cataloguePlaylistDetail(env.TOMIFY_DB, username, match[1]) })
  }
  return json({ error: 'not-found' }, 404)
}

export const catalogueWorkerSource = [spotifyRedirectUri, bytesToBase64, base64ToBytes, catalogueTokenKey, encryptCatalogueToken, decryptCatalogueToken, ensureCatalogueTables, spotifyTokenRequest, spotifyUserToken, spotifyApiJson, fetchSpotifyPlaylist, cataloguePlaylistRow, cataloguePlaylistDetail, saveCataloguePlaylist, recoveryForbidden, handleCatalogueRequest].map((fn) => fn.toString()).join('\n\n')
