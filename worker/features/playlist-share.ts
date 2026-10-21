// Playlists belong to one account. An owner can share a playlist with other Tomify accounts; recipients get read-only access.
// Navidrome only knows public/private, so sharing a Navidrome playlist also marks it public there (done by the owner's client)
// and Tomify decides who sees it from the playlist_shares rows here.

import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { navidromeUrl } from '../lib/navidrome.ts'
import { seal, unseal } from '../lib/seal.ts'

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

// Most songs one collaborator edit can send (a whole reordered playlist).
const MAX_EDIT_SONGS = 2000

// Keeps the owner's sealed Navidrome login while any of their shares lets someone edit, and drops it after.
async function syncOwnerLogin(request: Request, env: Env, owner: string) {
  const db = env.TOMIFY_DB
  const editors = await db.prepare('SELECT COUNT(*) AS count FROM playlist_shares WHERE owner = ? AND can_edit = 1').bind(owner).first<{ count: number }>()
  if (!editors?.count || !env.TOMIFY_MEDIA_KEY) {
    await db.prepare('DELETE FROM playlist_owner_logins WHERE owner = ?').bind(owner).run()
    return
  }
  const credential = await seal(env.TOMIFY_MEDIA_KEY, JSON.stringify({ u: request.headers.get('x-tomify-user'), t: request.headers.get('x-tomify-token'), s: request.headers.get('x-tomify-salt') }))
  await db.prepare('INSERT INTO playlist_owner_logins (owner, credential, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET credential = excluded.credential, updated_at = excluded.updated_at').bind(owner, credential, Date.now()).run()
}

// Changes a shared playlist's songs as its owner, for a recipient the owner lets edit it.
async function editAsOwner(env: Env, owner: string, playlistId: string, body: { action?: unknown; songIds?: unknown; indexes?: unknown }): Promise<Response> {
  const row = await env.TOMIFY_DB.prepare('SELECT credential FROM playlist_owner_logins WHERE owner = ?').bind(owner).first<{ credential: string }>()
  let login: Record<string, string> | null = null
  try { login = row && env.TOMIFY_MEDIA_KEY ? JSON.parse(await unseal(env.TOMIFY_MEDIA_KEY, row.credential)) : null } catch { login = null }
  if (!login) return json({ error: 'owner-login-missing', message: `Ask ${owner} to open Tomify once, then try again.` }, 409)
  const songIds = Array.isArray(body.songIds) ? body.songIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200).slice(0, MAX_EDIT_SONGS) : []
  const indexes = Array.isArray(body.indexes) ? body.indexes.filter((index): index is number => Number.isInteger(index) && index >= 0).slice(0, MAX_EDIT_SONGS) : []
  const form = new URLSearchParams()
  let endpoint = 'updatePlaylist'
  if (body.action === 'add' && songIds.length) { form.set('playlistId', playlistId); for (const id of songIds) form.append('songIdToAdd', id) }
  else if (body.action === 'remove' && indexes.length) { form.set('playlistId', playlistId); for (const index of indexes) form.append('songIndexToRemove', String(index)) }
  else if (body.action === 'replace') { endpoint = 'createPlaylist'; form.set('playlistId', playlistId); for (const id of songIds) form.append('songId', id) }
  else return json({ error: 'invalid-playlist-edit' }, 400)
  for (const [key, value] of Object.entries({ ...login, v: '1.16.1', c: 'Tomify', f: 'json' })) form.set(key, String(value))
  const response = await fetch(navidromeUrl(env, `/rest/${endpoint}.view`), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  const result = await response.json<{ 'subsonic-response'?: { status?: string; error?: { code?: number; message?: string } } }>().catch(() => null)
  const data = result?.['subsonic-response']
  if (data?.status === 'ok') return json({ ok: true })
  // 40/41: the owner's saved login no longer works (their password changed).
  if (data?.error?.code === 40 || data?.error?.code === 41) return json({ error: 'owner-login-expired', message: `Ask ${owner} to open Tomify once, then try again.` }, 409)
  return json({ error: 'playlist-edit-failed', message: data?.error?.message || 'The music server did not save the change.' }, 502)
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
      db.prepare('SELECT kind, playlist_id AS playlistId, owner, playlist_name AS name, can_edit AS canEdit FROM playlist_shares WHERE shared_with = ? ORDER BY playlist_name').bind(me).all<{ kind: string; playlistId: string; owner: string; name: string; canEdit: number }>(),
      db.prepare('SELECT kind, playlist_id AS playlistId, shared_with AS sharedWith, can_edit AS canEdit FROM playlist_shares WHERE owner = ? ORDER BY shared_with').bind(me).all<{ kind: string; playlistId: string; sharedWith: string; canEdit: number }>(),
    ])
    const sharedByMe: Array<{ kind: string; playlistId: string; sharedWith: string[]; editors: string[] }> = []
    for (const row of byMe.results || []) {
      let entry = sharedByMe.find((item) => item.kind === row.kind && item.playlistId === row.playlistId)
      if (!entry) sharedByMe.push(entry = { kind: row.kind, playlistId: row.playlistId, sharedWith: [], editors: [] })
      entry.sharedWith.push(row.sharedWith)
      if (row.canEdit) entry.editors.push(row.sharedWith)
    }
    // An owner with editors refreshes their saved login, so edits keep working after a password change.
    if (sharedByMe.some((entry) => entry.editors.length)) await syncOwnerLogin(request, env, me)
    return json({ accounts: (accounts.results || []).map((row) => row.username), sharedWithMe: (withMe.results || []).map((row) => ({ ...row, canEdit: Boolean(row.canEdit) })), sharedByMe, collaboration: Boolean(env.TOMIFY_MEDIA_KEY) })
  }

  const songs = url.pathname.match(/^\/api\/playlist-shares\/navidrome\/([^/]+)\/songs$/)
  if (songs && request.method === 'POST') {
    const playlistId = decodeURIComponent(songs[1])
    const share = await db.prepare('SELECT owner FROM playlist_shares WHERE kind = ? AND playlist_id = ? AND shared_with = ? AND can_edit = 1').bind('navidrome', playlistId, me).first<{ owner: string }>()
    if (!share) return json({ error: 'playlist-not-editable', message: 'Only people the owner lets edit this playlist can change it.' }, 403)
    return editAsOwner(env, share.owner, playlistId, await request.json<Record<string, unknown>>().catch(() => ({})))
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
    const input = await request.json<{ users?: unknown; editors?: unknown; name?: unknown }>().catch(() => ({} as { users?: unknown; editors?: unknown; name?: unknown }))
    const accounts = await db.prepare('SELECT username FROM tomify_accounts').all<{ username: string }>()
    const recipients = normaliseShareRecipients(input.users, me, (accounts.results || []).map((row) => row.username))
    // Only Navidrome playlists can be edited by others; imported playlists stay read-only.
    const editors = kind === 'navidrome' ? normaliseShareRecipients(input.editors, me, recipients) : []
    if (editors.length && !env.TOMIFY_MEDIA_KEY) return json({ error: 'collaboration-unavailable', message: 'Letting others edit needs TOMIFY_MEDIA_KEY set on the Worker.' }, 503)
    const name = String(playlist.name || input.name || 'Playlist').slice(0, 300)
    await db.batch([
      db.prepare('DELETE FROM playlist_shares WHERE kind = ? AND playlist_id = ?').bind(kind, playlistId),
      ...recipients.map((recipient) => db.prepare('INSERT INTO playlist_shares (kind, playlist_id, owner, shared_with, playlist_name, can_edit) VALUES (?, ?, ?, ?, ?, ?)').bind(kind, playlistId, me, recipient, name, editors.includes(recipient) ? 1 : 0)),
    ])
    await syncOwnerLogin(request, env, me)
    return json({ kind, playlistId, sharedWith: recipients, editors })
  }
  return json({ error: 'not-found' }, 404)
}

export { PLAYLIST_SHARE_KINDS, normaliseAccountName, normaliseShareRecipients, rememberTomifyAccount, playlistShareFor, handlePlaylistShareRequest }
