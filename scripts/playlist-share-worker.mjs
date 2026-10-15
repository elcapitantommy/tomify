// Playlists belong to one account. An owner can share a playlist with other Tomify accounts; recipients get read-only access.
// Navidrome only knows public/private, so sharing a Navidrome playlist also marks it public there (done by the owner's client)
// and Tomify decides who sees it from the playlist_shares rows here.

const PLAYLIST_SHARE_KINDS = ['navidrome', 'imported']

function normaliseAccountName(value) {
  return String(value || '').trim().toLowerCase()
}

function normaliseShareRecipients(users, owner, knownAccounts) {
  const known = new Map(knownAccounts.map((account) => [normaliseAccountName(account), account]))
  const ownerKey = normaliseAccountName(owner)
  const recipients = []
  for (const user of Array.isArray(users) ? users : []) {
    const key = normaliseAccountName(user)
    if (!key || key === ownerKey || !known.has(key)) continue
    if (!recipients.some((recipient) => normaliseAccountName(recipient) === key)) recipients.push(known.get(key))
  }
  return recipients
}

async function ensurePlaylistShareTables(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS playlist_shares (kind TEXT NOT NULL, playlist_id TEXT NOT NULL, owner TEXT NOT NULL, shared_with TEXT NOT NULL, playlist_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (kind, playlist_id, shared_with))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_playlist_shares_recipient ON playlist_shares(shared_with)'),
    db.prepare('CREATE TABLE IF NOT EXISTS tomify_accounts (username TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'),
  ])
}

async function rememberTomifyAccount(db, username) {
  await db.prepare('INSERT INTO tomify_accounts (username) VALUES (?) ON CONFLICT(username) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP').bind(normaliseAccountName(username)).run()
}

async function playlistShareFor(db, kind, playlistId, username) {
  return db.prepare('SELECT owner, playlist_name AS name FROM playlist_shares WHERE kind = ? AND playlist_id = ? AND shared_with = ?').bind(kind, playlistId, normaliseAccountName(username)).first()
}

async function navidromePlaylistOwner(request, playlistId) {
  const url = new URL('https://tomify.tomdixon.uk/rest/getPlaylist.view')
  url.searchParams.set('u', request.headers.get('x-tomify-user') || '')
  url.searchParams.set('t', request.headers.get('x-tomify-token') || '')
  url.searchParams.set('s', request.headers.get('x-tomify-salt') || '')
  url.searchParams.set('v', '1.16.1')
  url.searchParams.set('c', 'Tomify')
  url.searchParams.set('f', 'json')
  url.searchParams.set('id', playlistId)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    const body = await response.json()
    const playlist = body?.['subsonic-response']?.status === 'ok' ? body['subsonic-response'].playlist : null
    return playlist ? { owner: String(playlist.owner || ''), name: String(playlist.name || '') } : null
  } catch {
    return null
  }
}

async function handlePlaylistShareRequest(request, env, url) {
  if (!url.pathname.startsWith('/api/playlist-shares')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'playlist-share-store-unavailable' }, 503)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  const db = env.TOMIFY_DB
  await ensurePlaylistShareTables(db)
  await rememberTomifyAccount(db, username)
  const me = normaliseAccountName(username)

  if (url.pathname === '/api/playlist-shares' && request.method === 'GET') {
    const [accounts, withMe, byMe] = await Promise.all([
      db.prepare('SELECT username FROM tomify_accounts WHERE username != ? ORDER BY username').bind(me).all(),
      db.prepare('SELECT kind, playlist_id AS playlistId, owner, playlist_name AS name FROM playlist_shares WHERE shared_with = ? ORDER BY playlist_name').bind(me).all(),
      db.prepare('SELECT kind, playlist_id AS playlistId, shared_with AS sharedWith FROM playlist_shares WHERE owner = ? ORDER BY shared_with').bind(me).all(),
    ])
    const sharedByMe = []
    for (const row of byMe.results || []) {
      const existing = sharedByMe.find((entry) => entry.kind === row.kind && entry.playlistId === row.playlistId)
      if (existing) existing.sharedWith.push(row.sharedWith)
      else sharedByMe.push({ kind: row.kind, playlistId: row.playlistId, sharedWith: [row.sharedWith] })
    }
    return json({ accounts: (accounts.results || []).map((row) => row.username), sharedWithMe: withMe.results || [], sharedByMe })
  }

  const match = url.pathname.match(/^\/api\/playlist-shares\/([^/]+)\/([^/]+)$/)
  if (match && request.method === 'PUT') {
    const kind = match[1]
    const playlistId = decodeURIComponent(match[2])
    if (!PLAYLIST_SHARE_KINDS.includes(kind)) return json({ error: 'not-found' }, 404)
    let playlist = null
    if (kind === 'imported') {
      await ensureCatalogueTables(db)
      const row = await db.prepare('SELECT username, name FROM catalogue_playlists WHERE id = ?').bind(playlistId).first()
      playlist = row ? { owner: String(row.username), name: String(row.name) } : null
    } else {
      playlist = await navidromePlaylistOwner(request, playlistId)
    }
    if (!playlist || normaliseAccountName(playlist.owner) !== me) return json({ error: 'playlist-not-found', message: 'Only the playlist\'s owner can change who it is shared with.' }, 404)
    const input = await request.json().catch(() => ({}))
    const accounts = await db.prepare('SELECT username FROM tomify_accounts').all()
    const recipients = normaliseShareRecipients(input.users, me, (accounts.results || []).map((row) => row.username))
    const name = String(playlist.name || input.name || 'Playlist').slice(0, 300)
    await db.batch([
      db.prepare('DELETE FROM playlist_shares WHERE kind = ? AND playlist_id = ?').bind(kind, playlistId),
      ...recipients.map((recipient) => db.prepare('INSERT INTO playlist_shares (kind, playlist_id, owner, shared_with, playlist_name) VALUES (?, ?, ?, ?, ?)').bind(kind, playlistId, me, recipient, name)),
    ])
    return json({ kind, playlistId, sharedWith: recipients })
  }
  return json({ error: 'not-found' }, 404)
}

export { PLAYLIST_SHARE_KINDS, normaliseAccountName, normaliseShareRecipients, ensurePlaylistShareTables, rememberTomifyAccount, playlistShareFor, handlePlaylistShareRequest }
export const playlistShareWorkerSource = ['const PLAYLIST_SHARE_KINDS = ' + JSON.stringify(PLAYLIST_SHARE_KINDS), ...[normaliseAccountName, normaliseShareRecipients, ensurePlaylistShareTables, rememberTomifyAccount, playlistShareFor, navidromePlaylistOwner, handlePlaylistShareRequest].map((fn) => fn.toString())].join('\n\n')
