// Quality tiers in the Worker: the preferred-target setting (D1, admin-only), the status a completed
// recovery import gets, and the one-off "Re-check quality labels" run. The classifier itself lives in
// shared/quality.mjs. handleQualityRequest relies on Worker globals (authenticate, isNavidromeAdmin,
// json).
//
// The job and acquire routes in worker/routes/recovery.ts call recoveryImportStatus(quality) synchronously, so
// handleQualityRequest loads the saved target into qualityTargetState before any /api/recovery route runs.
import { classifyQuality, defaultQualityTarget, qualityMeetsTarget, qualityTargets, qualityTierDescription } from '../../shared/quality.mjs'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

export const qualityTargetState = { target: 'transparent-lossy' }

/** `recovered` when the tier meets the target, otherwise `needs-upgrade`. */
export function recoveryStatusForTier(tier, target) {
  return qualityMeetsTarget(tier, target) ? 'recovered' : 'needs-upgrade'
}
export function recoveryStatusForQuality(quality, target) {
  return recoveryStatusForTier(classifyQuality(quality).tier, target)
}

/** Status for a completed recovery import, against the saved preferred target. */
export function recoveryImportStatus(quality) {
  return recoveryStatusForQuality(quality, qualityTargetState.target)
}

export function qualityTargetOptions() {
  const labels = { lossless: 'Lossless only', 'transparent-lossy': 'Transparent or better', lossy: 'Any copy' }
  return qualityTargets().map((id) => ({ id, label: labels[id], description: id === 'lossy' ? 'Any lossy copy with a measured bitrate is good enough' : qualityTierDescription(id) }))
}

// The quality a recovered item was judged on: the preserved source as probed at import, else the
// figures stored on the candidate row.
export function storedSourceQuality(row) {
  let provenance = null
  try { provenance = row?.provenanceJson ? JSON.parse(row.provenanceJson) : null } catch { provenance = null }
  const source = provenance?.sourceAudio?.quality
  if (source && (source.codec || source.container)) return source
  return { codec: row?.codec ?? null, container: row?.container ?? null, bitrate: row?.bitrate == null ? null : Number(row.bitrate) }
}

/** The items whose status a re-check would change: [{ id, status }]. */
export function qualityRecheckChanges(rows, target) {
  const seen = new Set()
  const changes = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id || seen.has(row.id)) continue
    seen.add(row.id)
    if (row.status !== 'recovered' && row.status !== 'needs-upgrade') continue
    const status = recoveryStatusForQuality(storedSourceQuality(row), target)
    if (status !== row.status) changes.push({ id: row.id, status })
  }
  return changes
}


async function loadQualityTarget(db) {
  const row = await db.prepare("SELECT value FROM tomify_settings WHERE key = 'quality_target'").first()
  const target = qualityTargets().includes(row?.value) ? row.value : defaultQualityTarget()
  qualityTargetState.target = target
  return target
}

export async function handleQualityRequest(request, env, url) {
  const pathname = url.pathname
  const db = env && env.TOMIFY_DB
  if (pathname === '/api/recovery' || pathname.startsWith('/api/recovery/')) {
    // Not handled here: refresh the target that recoveryImportStatus reads, then let the Recovery routes run.
    if (db) { try { await loadQualityTarget(db) } catch { qualityTargetState.target = defaultQualityTarget() } }
    return null
  }
  if (pathname !== '/api/settings/quality' && pathname !== '/api/settings/quality/recheck') return null
  if (!db) return json({ error: 'settings-store-unavailable' }, 503)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can change quality settings.' }, 403)

  if (pathname === '/api/settings/quality' && request.method === 'GET') {
    return json({ target: await loadQualityTarget(db), targets: qualityTargetOptions() })
  }
  if (pathname === '/api/settings/quality' && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}))
    if (!qualityTargets().includes(body?.target)) return json({ error: 'invalid-target', message: 'Choose lossless, transparent-lossy or lossy.' }, 400)
    await db.prepare("INSERT INTO tomify_settings (key, value, updated_at, updated_by) VALUES ('quality_target', ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(body.target, username).run()
    qualityTargetState.target = body.target
    return json({ target: body.target, targets: qualityTargetOptions() })
  }
  if (pathname === '/api/settings/quality/recheck' && request.method === 'POST') {
    const target = await loadQualityTarget(db)
    const rows = await db.prepare("SELECT i.id AS id, i.status AS status, c.codec AS codec, c.container AS container, c.bitrate AS bitrate, c.provenance_json AS provenanceJson FROM recovery_items i LEFT JOIN recovery_candidates c ON c.recovery_id = i.id AND c.selected = 1 WHERE i.status IN ('recovered', 'needs-upgrade') ORDER BY c.imported_path IS NULL, c.updated_at DESC").all()
    const results = rows.results || []
    const changes = qualityRecheckChanges(results, target)
    // D1 caps queries per request, so write the changes in batches.
    for (let offset = 0; offset < changes.length; offset += 50) {
      await db.batch(changes.slice(offset, offset + 50).map((change) => db.prepare('UPDATE recovery_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(change.status, change.id)))
    }
    const checked = new Set(results.map((row) => row.id)).size
    return json({ target, checked, changed: changes.length, recovered: changes.filter((change) => change.status === 'recovered').length, needsUpgrade: changes.filter((change) => change.status === 'needs-upgrade').length })
  }
  return json({ error: 'method-not-allowed' }, 405)
}
