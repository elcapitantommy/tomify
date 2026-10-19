// Playlists belong to one account. An owner can share a playlist with other Tomify accounts; recipients get read-only access.
// Navidrome only knows public/private, so sharing a Navidrome playlist also marks it public there (done by the owner's client)
// and Tomify decides who sees it from the playlist_shares rows here.

import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { navidromeUrl } from '../lib/navidrome.ts'

const PLAYLIST_SHARE_KINDS = ['navidrome', 'imported']

function normaliseAccountName(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function normaliseShareRecipients(users: unknown, owner: string, knownAccounts: string[]): string[] {
  const known = new Map(knownAccounts.map((account) => [normaliseAccountName(account), account]))
  const ownerKey = normaliseAccountName(owner)
  const recipients: string[] = []
  for (const user of Array.isArray(users) ? users : []) {
    const key = normaliseAccountName(user)
    if (!key || key === ownerKey || !known.has(key)) continue
    if (!recipients.some((recipient) => normaliseAccountName(recipient) === key)) recipients.push(known.get(key) as string)
  }
  return recipients
}


async function rememberTomifyAccount(db: D1Database, username: string) {
  await db.prepare('INSERT INTO tomify_accounts (username) VALUES (?) ON CONFLICT(username) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP').bind(normaliseAccountName(username)).run()
}

async function playlistShareFor(db: D1Database, kind: string, playlistId: string, username: string) {
  return db.prepare('SELECT owner, playlist_name AS name FROM playlist_shares WHERE kind = ? AND playlist_id = ? AND shared_with = ?').bind(kind, playlistId, normaliseAccountName(username)).first<{ owner: string; name: string }>()
}

async function navidromePlaylistOwner(request: Request, env: Env, playlistId: string): Promise<{ owner: string; name: string } | null> {
  const url = navidromeUrl(env, '/rest/getPlaylist.view')
  url.searchParams.set('u', request.headers.get('x-tomify-user') || '')
  url.searchParams.set('t', request.headers.get('x-tomify-token') || '')
  url.searchParams.set('s', request.headers.get('x-tomify-salt') || '')
  url.searchParams.set('v', '1.16.1')
  url.searchParams.set('c', 'Tomify')
  url.searchParams.set('f', 'json')
  url.searchParams.set('id', playlistId)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    const body = await response.json<{ 'subsonic-response'?: { status?: string; playlist?: { owner?: string; name?: string } } }>()
    const playlist = body?.['subsonic-response']?.status === 'ok' ? body['subsonic-response']!.playlist : null
    return playlist ? { owner: String(playlist.owner || ''), name: String(playlist.name || '') } : null
  } catch {
    return null
  }
}

async function handlePlaylistShareRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/playlist-shares')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'playlist-share-store-unavailable' }, 503)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  const db = env.TOMIFY_DB
  await rememberTomifyAccount(db, username)
  const me = normaliseAccountName(username)

  if (url.pathname === '/api/playlist-shares' && request.method === 'GET') {
    const [accounts, withMe, byMe] = await Promise.all([
      db.prepare('SELECT username FROM tomify_accounts WHERE username != ? ORDER BY username').bind(me).all<{ username: string }>(),
      db.prepare('SELECT kind, playlist_id AS playlistId, owner, playlist_name AS name FROM playlist_shares WHERE shared_with = ? ORDER BY playlist_name').bind(me).all<{ kind: string; playlistId: string; owner: string; name: string }>(),
      db.prepare('SELECT kind, playlist_id AS playlistId, shared_with AS sharedWith FROM playlist_shares WHERE owner = ? ORDER BY shared_with').bind(me).all<{ kind: string; playlistId: string; sharedWith: string }>(),
    ])
    const sharedByMe: Array<{ kind: string; playlistId: string; sharedWith: string[] }> = []
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
    let playlist: { owner: string; name: string } | null = null
    if (kind === 'imported') {
      const row = await db.prepare('SELECT username, name FROM catalogue_playlists WHERE id = ?').bind(playlistId).first<{ username: string; name: string }>()
      playlist = row ? { owner: String(row.username), name: String(row.name) } : null
    } else {
      playlist = await navidromePlaylistOwner(request, env, playlistId)
    }
    if (!playlist || normaliseAccountName(playlist.owner) !== me) return json({ error: 'playlist-not-found', message: 'Only the playlist\'s owner can change who it is shared with.' }, 404)
    const input = await request.json<{ users?: unknown; name?: unknown }>().catch(() => ({} as { users?: unknown; name?: unknown }))
    const accounts = await db.prepare('SELECT username FROM tomify_accounts').all<{ username: string }>()
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

export { PLAYLIST_SHARE_KINDS, normaliseAccountName, normaliseShareRecipients, rememberTomifyAccount, playlistShareFor, handlePlaylistShareRequest }
