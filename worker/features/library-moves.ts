import type { Env } from '../env.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent, RecoveryAgentOutdated } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

// Navidrome song ids the browser matched before applying: each copy moved away maps to the copy that stays.
function relinkPairs(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).slice(0, 200)
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string' && Boolean(pair[0] && pair[1]) && pair[0] !== pair[1] && pair[0].length <= 200 && pair[1].length <= 200)
}

// Imported-playlist rows and Recovery playback records that used a moved-away song now use the kept one. Undoing
// the move does not change these back; the kept song stays a valid link.
async function relinkSongs(env: Env, pairs: Array<[string, string]>) {
  if (!env?.TOMIFY_DB || !pairs.length) return 0
  const db = env.TOMIFY_DB
  await db.batch(pairs.flatMap(([from, to]) => [
    db.prepare("UPDATE catalogue_playlist_items SET local_track_id = ?, local_track_json = json_set(local_track_json, '$.id', ?), updated_at = CURRENT_TIMESTAMP WHERE local_track_id = ?").bind(to, to, from),
    db.prepare("UPDATE recovery_items SET playback_json = json_set(playback_json, '$.songId', ?) WHERE json_extract(playback_json, '$.songId') = ?").bind(to, from),
  ]))
  return pairs.length
}

// Admin-only supervised merges and promotions on the recovery agent: plan is read-only, apply and undo rename files
// and keep a journal there. An older agent answers 404; expose that as unavailable.
export async function handleLibraryMovesRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/library-moves\/(plan|apply|undo|list)$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can move library files.' }, 403)
  const { relink, ...body } = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  try {
    const result = await callRecoveryAgent(env, `/v1/library/moves/${match[1]}`, body)
    if (match[1] === 'apply') result.relinked = await relinkSongs(env, relinkPairs(relink))
    return json(result)
  } catch (error) {
    if (error instanceof RecoveryAgentOutdated) return json({ error: 'library-moves-not-available', message: 'Library moves are not available on this recovery agent. Redeploy it.' }, 404)
    return json({ error: 'library-move-failed', message: error instanceof Error ? error.message : 'The library move failed.' }, 502)
  }
}
