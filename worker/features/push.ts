// Push notifications: a phone or computer subscribes for topics, and the Worker's crons send them.
// "recovery" (administrators): a Recovery download finished importing or failed. "new-releases": an artist in the
// library put out something new.
import type { Env, RouteHandler } from '../env.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent } from '../lib/agent.ts'
import { json } from '../lib/http.ts'
import { generateVapidKeys, sendPush, type PushTarget, type VapidKeys } from '../lib/web-push.ts'

export const PUSH_TOPICS = ['recovery', 'new-releases']
export interface PushMessage { title: string; body: string; url: string; tag?: string }
interface SubscriptionRow extends PushTarget { username: string; topics: string }

const DAY_MS = 24 * 60 * 60 * 1000
// A release counts as new for a notification if it came out in the last week, or is still to come.
const NEW_RELEASE_NOTIFY_DAYS = 7

export async function vapidKeys(env: Pick<Env, 'TOMIFY_DB'>, origin?: string): Promise<VapidKeys | null> {
  const db = env.TOMIFY_DB
  const row = await db.prepare('SELECT public_key AS publicKey, private_key AS privateKey, subject FROM push_keys WHERE id = 1').first<VapidKeys>()
  if (row || !origin) return row ?? null
  const keys = await generateVapidKeys(origin)
  // Two first requests at once keep whichever pair was saved first.
  await db.prepare('INSERT INTO push_keys (id, public_key, private_key, subject) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(keys.publicKey, keys.privateKey, keys.subject).run()
  return db.prepare('SELECT public_key AS publicKey, private_key AS privateKey, subject FROM push_keys WHERE id = 1').first<VapidKeys>()
}

// Sends a message to every subscription that wants `topic` (only `username`'s, when given). Gone subscriptions are removed.
export async function notify(env: Pick<Env, 'TOMIFY_DB'>, topic: string, message: PushMessage, username?: string, fetcher: typeof fetch = fetch) {
  const keys = await vapidKeys(env)
  if (!keys) return 0
  const rows = await env.TOMIFY_DB.prepare(`SELECT endpoint, username, p256dh, auth, topics FROM push_subscriptions${username ? ' WHERE username = ?' : ''}`).bind(...(username ? [username] : [])).all<SubscriptionRow>()
  let sent = 0
  for (const row of rows.results || []) {
    if (!row.topics.split(',').includes(topic)) continue
    try {
      const status = await sendPush(keys, row, JSON.stringify(message), Date.now(), fetcher)
      if (status === 404 || status === 410) await env.TOMIFY_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(row.endpoint).run()
      else if (status < 300) sent += 1
    } catch (error) { console.warn('Push failed', error instanceof Error ? error.message : error) }
  }
  return sent
}

// Every five minutes: announce Recovery downloads that finished since the last check. The page still records the
// import itself when it next looks at the job; this only reads the agent's job status.
export async function checkRecoveryJobs(env: Env, fetcher: typeof fetch = fetch) {
  const db = env.TOMIFY_DB
  if (!db || !env.RECOVERY_AGENT_URL) return 0
  const listeners = await db.prepare("SELECT DISTINCT username FROM push_subscriptions WHERE ',' || topics || ',' LIKE '%,recovery,%'").all<{ username: string }>()
  const users = (listeners.results || []).map((row) => row.username)
  if (!users.length) return 0
  const active = await db.prepare(`SELECT i.username, i.artist, i.album, i.title, c.provenance_json AS provenance FROM recovery_items i JOIN recovery_candidates c ON c.recovery_id = i.id AND c.selected = 1 WHERE i.status IN ('queued', 'downloading', 'importing') AND i.username IN (${users.map(() => '?').join(', ')})`).bind(...users).all<{ username: string; artist: string; album: string | null; title: string; provenance: string | null }>()
  let sent = 0
  for (const item of active.results || []) {
    let jobId: unknown
    try { jobId = JSON.parse(item.provenance || '{}')?.job?.id } catch { jobId = null }
    if (typeof jobId !== 'string' || !jobId) continue
    if (await db.prepare('SELECT 1 AS found FROM push_recovery_sent WHERE job_id = ?').bind(jobId).first()) continue
    let job: { status?: string; error?: string } | undefined
    try { job = (await callRecoveryAgent(env, '/v1/jobs/status', { jobId }))?.job } catch { continue }
    if (job?.status !== 'completed' && job?.status !== 'failed') continue
    await db.prepare('INSERT INTO push_recovery_sent (job_id, sent_at) VALUES (?, ?) ON CONFLICT(job_id) DO NOTHING').bind(jobId, Date.now()).run()
    const name = [item.artist, item.album || item.title].filter(Boolean).join(' – ') || 'Your download'
    sent += await notify(env, 'recovery', job.status === 'completed'
      ? { title: 'Recovery finished', body: `${name} is in your library.`, url: '/recovery', tag: `recovery-${jobId}` }
      : { title: 'Recovery download failed', body: `${name}: ${String(job.error || 'the download failed').slice(0, 140)}`, url: '/recovery', tag: `recovery-${jobId}` }, item.username, fetcher)
  }
  await db.prepare('DELETE FROM push_recovery_sent WHERE sent_at < ?').bind(Date.now() - 60 * DAY_MS).run()
  return sent
}

// After the daily new-release check: one message listing what it found that is new or announced.
export async function notifyNewReleases(env: Pick<Env, 'TOMIFY_DB'>, foundAt: number, fetcher: typeof fetch = fetch) {
  const since = new Date(foundAt - NEW_RELEASE_NOTIFY_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await env.TOMIFY_DB.prepare('SELECT artist_name AS artist, title FROM new_releases WHERE found_at = ? AND release_date >= ? ORDER BY release_date DESC LIMIT 20').bind(foundAt, since).all<{ artist: string; title: string }>()
  const found = rows.results || []
  if (!found.length) return 0
  const names = found.slice(0, 3).map((row) => `${row.artist} – ${row.title}`)
  const body = found.length > 3 ? `${names.join(', ')} and ${found.length - 3} more.` : `${names.join(', ')}.`
  return notify(env, 'new-releases', { title: found.length === 1 ? 'New from your artists' : `${found.length} new releases from your artists`, body, url: '/', tag: 'new-releases' }, undefined, fetcher)
}

const cleanTopics = (value: unknown, admin: boolean) => (Array.isArray(value) ? value : []).filter((topic): topic is string => typeof topic === 'string' && PUSH_TOPICS.includes(topic) && (admin || topic !== 'recovery'))

export const handlePushRequest: RouteHandler = async (request, env, url) => {
  if (!url.pathname.startsWith('/api/push')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'push-unavailable' }, 503)
  const signedIn = await authenticate(request, env)
  if (!signedIn) return json({ error: 'unauthorized' }, 401)
  const username = signedIn.toLowerCase()

  // The public key to subscribe with, and what this browser is subscribed to (by its endpoint).
  if (url.pathname === '/api/push' && request.method === 'GET') {
    const keys = await vapidKeys(env, url.origin)
    const endpoint = url.searchParams.get('endpoint')
    const row = endpoint ? await env.TOMIFY_DB.prepare('SELECT topics FROM push_subscriptions WHERE endpoint = ? AND username = ?').bind(endpoint, username).first<{ topics: string }>() : null
    return json({ publicKey: keys?.publicKey ?? null, topics: row ? row.topics.split(',').filter(Boolean) : null })
  }
  if (url.pathname === '/api/push/subscription' && request.method === 'PUT') {
    const body = await request.json<{ subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; topics?: unknown }>().catch(() => null)
    const subscription = body?.subscription
    const endpoint = typeof subscription?.endpoint === 'string' && subscription.endpoint.startsWith('https://') ? subscription.endpoint.slice(0, 1000) : null
    const p256dh = typeof subscription?.keys?.p256dh === 'string' ? subscription.keys.p256dh.slice(0, 200) : null
    const auth = typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth.slice(0, 100) : null
    if (!endpoint || !p256dh || !auth) return json({ error: 'invalid-subscription' }, 400)
    const topics = cleanTopics(body?.topics, (body?.topics as unknown[] | undefined)?.includes('recovery') ? await isNavidromeAdmin(request, signedIn, env) : false)
    if (!topics.length) await env.TOMIFY_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
    else await env.TOMIFY_DB.prepare('INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, topics, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth, topics = excluded.topics').bind(endpoint, username, p256dh, auth, topics.join(','), Date.now()).run()
    return json({ topics })
  }
  if (url.pathname === '/api/push/test' && request.method === 'POST') {
    const keys = await vapidKeys(env, url.origin)
    const rows = await env.TOMIFY_DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?').bind(username).all<PushTarget>()
    let sent = 0
    for (const row of rows.results || []) {
      const status = await sendPush(keys!, row, JSON.stringify({ title: 'Tomify', body: 'Notifications are working.', url: '/settings', tag: 'test' })).catch(() => 0)
      if (status === 404 || status === 410) await env.TOMIFY_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(row.endpoint).run()
      else if (status && status < 300) sent += 1
    }
    return json({ sent })
  }
  return json({ error: 'not-found' }, 404)
}
