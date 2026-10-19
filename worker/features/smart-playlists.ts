// Smart playlists: each account's saved rules. The browser does the matching (see src/lib/smart-playlists.ts).
import type { RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

interface SmartPlaylistRow { id: string; name: string; rulesJson: string; updatedAt: string }
const MAX_PLAYLISTS = 100

function row(value: SmartPlaylistRow) {
  let rules: unknown = {}
  try { rules = JSON.parse(value.rulesJson) } catch { /* a corrupt row reads as no rules */ }
  return { id: value.id, name: value.name, rules, updatedAt: value.updatedAt }
}

export const handleSmartPlaylistRequest: RouteHandler = async (request, env, url) => {
  const match = url.pathname.match(/^\/api\/smart-playlists(?:\/([\w-]{1,64}))?$/)
  if (!match) return null
  if (!env?.TOMIFY_DB) return json({ error: 'smart-playlists-unavailable' }, 503)
  const signedIn = await authenticate(request, env)
  if (!signedIn) return json({ error: 'unauthorized' }, 401)
  const username = signedIn.toLowerCase()
  const db = env.TOMIFY_DB
  const id = match[1]
  const select = 'SELECT id, name, rules_json AS rulesJson, updated_at AS updatedAt FROM smart_playlists WHERE username = ?'
  if (request.method === 'GET') {
    if (!id) return json({ playlists: ((await db.prepare(select + ' ORDER BY name COLLATE NOCASE').bind(username).all<SmartPlaylistRow>()).results || []).map(row) })
    const found = await db.prepare(select + ' AND id = ?').bind(username, id).first<SmartPlaylistRow>()
    return found ? json(row(found)) : json({ error: 'not-found' }, 404)
  }
  if (request.method === 'DELETE' && id) {
    await db.prepare('DELETE FROM smart_playlists WHERE username = ? AND id = ?').bind(username, id).run()
    return json({ deleted: true })
  }
  if (request.method !== 'PUT' && request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const body = await request.json().catch(() => null) as { name?: unknown; rules?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''
  const rules = body?.rules && typeof body.rules === 'object' && !Array.isArray(body.rules) ? JSON.stringify(body.rules) : ''
  if (!name || !rules || rules.length > 4000) return json({ error: 'invalid-smart-playlist' }, 400)
  if (request.method === 'POST' && !id) {
    const count = await db.prepare('SELECT COUNT(*) AS count FROM smart_playlists WHERE username = ?').bind(username).first<{ count: number }>()
    if ((count?.count || 0) >= MAX_PLAYLISTS) return json({ error: 'too-many-smart-playlists' }, 409)
    const created = crypto.randomUUID()
    await db.prepare('INSERT INTO smart_playlists (id, username, name, rules_json) VALUES (?, ?, ?, ?)').bind(created, username, name, rules).run()
    return json(row((await db.prepare(select + ' AND id = ?').bind(username, created).first<SmartPlaylistRow>())!), 201)
  }
  if (request.method !== 'PUT' || !id) return json({ error: 'method-not-allowed' }, 405)
  await db.prepare('UPDATE smart_playlists SET name = ?, rules_json = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ? AND id = ?').bind(name, rules, username, id).run()
  const saved = await db.prepare(select + ' AND id = ?').bind(username, id).first<SmartPlaylistRow>()
  return saved ? json(row(saved)) : json({ error: 'not-found' }, 404)
}
