import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent, RecoveryAgentOutdated } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

function parseInventoryTracklists(rows) {
  const tracklists = []
  for (const row of rows || []) {
    try { const tracklist = JSON.parse(row.tracklistJson); if (tracklist && Array.isArray(tracklist.tracks)) tracklists.push(tracklist) } catch { /* ignore a corrupt cache row */ }
  }
  return tracklists
}
// D1 timestamps are UTC without a zone ('2026-10-16 19:50:00'); the agent's are ISO strings.
function inventoryTime(value) {
  const text = String(value || '').trim()
  if (!text) return NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z')
}

// A record is only missing its file when a completed scan ran after it was imported: with no scan yet, or a scan
// older than the import, the inventory simply has not seen the file.
function inventoryMissingRows(rows, report) {
  const scanned = inventoryTime(report?.completedAt)
  if (!Number.isFinite(scanned)) return []
  return rows.filter((row) => {
    if (report.checkedPaths?.[row.importedPath] !== false) return false
    const imported = inventoryTime(row.updatedAt)
    return !Number.isFinite(imported) || imported <= scanned
  })
}

// The album folder of an imported file, for records of wanted music that name only an artist.
function inventoryFolderName(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : null
}

function addInventoryLinks(report, importedRows) {
  const pathToRecovery = new Map(importedRows.map((row) => [row.importedPath, row.id]))
  for (const category of ['duplicates', 'partialAlbums', 'orphanedSources', 'shadowedRecovery']) {
    for (const entry of report?.[category] || []) {
      const recoveryId = (entry.paths || []).map((path) => pathToRecovery.get(path)).find(Boolean)
      if (recoveryId) entry.recoveryId = recoveryId
    }
  }
}

// Findings an administrator marked as fine are matched by category and their sorted paths, so a finding returns
// as soon as its files change.
function inventoryDismissible(category) { return ['duplicates', 'partialAlbums', 'orphanedSources', 'shadowedRecovery'].includes(category) }
function inventoryDismissalKey(paths) { return [...(paths || [])].map(String).sort().join('\n') }

function applyInventoryDismissals(report, rows) {
  const marked = new Map<string, { dismissedBy?: unknown, createdAt?: unknown }>((rows || []).map((row) => [`${row.category}\0${row.pathsKey}`, row]))
  report.dismissed = []
  for (const category of ['duplicates', 'partialAlbums', 'orphanedSources', 'shadowedRecovery']) {
    const open = []
    for (const entry of report[category] || []) {
      const row = marked.get(`${category}\0${inventoryDismissalKey(entry.paths)}`)
      if (row) report.dismissed.push({ ...entry, category, dismissedBy: row.dismissedBy || null, dismissedAt: row.createdAt || null })
      else open.push(entry)
    }
    report[category] = open
  }
}

async function handleInventoryDismissal(request, env, username) {
  if (!env?.TOMIFY_DB) return json({ error: 'inventory-store-unavailable' }, 503)
  const body = await request.json().catch(() => ({}))
  const category = String(body?.category || '')
  const paths = Array.isArray(body?.paths) ? body.paths.map(String).filter(Boolean) : []
  if (!inventoryDismissible(category) || paths.length === 0 || paths.length > 1000) return json({ error: 'invalid-dismissal', message: 'Choose a Library health finding to mark.' }, 400)
  const key = inventoryDismissalKey(paths)
  if (body.restore === true) await env.TOMIFY_DB.prepare('DELETE FROM library_health_dismissals WHERE category = ? AND paths_key = ?').bind(category, key).run()
  else await env.TOMIFY_DB.prepare('INSERT OR REPLACE INTO library_health_dismissals (category, paths_key, label, dismissed_by) VALUES (?, ?, ?, ?)').bind(category, key, String(body.label || '').slice(0, 500), username).run()
  return json({ ok: true })
}

// Admin-only access to the recovery agent's read-only inventory. An older agent answers 404;
// expose that as unavailable rather than an agent or contract failure.
export async function handleInventoryRequest(request, env, url) {
  const match = url.pathname.match(/^\/api\/inventory\/(scan|status|summary|report|dismiss)$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can inspect the library inventory.' }, 403)
  try {
    if (match[1] === 'dismiss') return await handleInventoryDismissal(request, env, username)
    let payload = {}
    let importedRows = []
    let dismissals = []
    if (match[1] === 'report') {
      if (!env?.TOMIFY_DB) return json({ error: 'inventory-store-unavailable' }, 503)
      const [tracklistRows, recoveryRows, dismissalRows] = await Promise.all([
        env.TOMIFY_DB.prepare('SELECT tracklist_json AS tracklistJson FROM release_tracklists').all(),
        env.TOMIFY_DB.prepare("SELECT i.id, i.artist, i.album, i.title, c.imported_path AS importedPath, c.updated_at AS updatedAt FROM recovery_items i JOIN recovery_candidates c ON c.recovery_id = i.id AND c.selected = 1 WHERE i.username = ? AND i.status IN ('recovered', 'needs-upgrade', 'imported') AND c.imported_path IS NOT NULL").bind(username).all(),
        env.TOMIFY_DB.prepare('SELECT category, paths_key AS pathsKey, dismissed_by AS dismissedBy, created_at AS createdAt FROM library_health_dismissals').all(),
      ])
      dismissals = dismissalRows.results || []
      importedRows = recoveryRows.results || []
      payload = { tracklists: parseInventoryTracklists(tracklistRows.results), checkPaths: importedRows.map((row) => row.importedPath) }
    }
    const result = await callRecoveryAgent(env, `/v1/inventory/${match[1]}`, payload)
    if (match[1] === 'report') {
      const report = result?.report || {}
      addInventoryLinks(report, importedRows)
      applyInventoryDismissals(report, dismissals)
      report.missingD1Files = inventoryMissingRows(importedRows, report).map((row) => ({
        kind: 'missing-d1-file', label: `${row.artist || 'Unknown artist'} — ${row.title || row.album || inventoryFolderName(row.importedPath) || 'Recovery item'}`, paths: [row.importedPath], recoveryId: row.id,
      }))
      delete report.checkedPaths
      return json({ report })
    }
    return json(result, match[1] === 'scan' && result?.started ? 202 : 200)
  } catch (error) {
    if (error instanceof RecoveryAgentOutdated) return json({ error: 'inventory-not-available', message: 'Library inventory is not available on this recovery agent.' }, 404)
    return json({ error: 'inventory-failed', message: error instanceof Error ? error.message : 'The library inventory request failed.' }, 502)
  }
}
