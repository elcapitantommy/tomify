import type { Env } from '../env.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent, RecoveryAgentOutdated } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

// A recovery item and the file its selected candidate imported.
interface ImportedRow { id: string; artist: string | null; album: string | null; title: string | null; importedPath: string; updatedAt: string | null }
interface DismissalRow { category: string; pathsKey: string; dismissedBy: string | null; createdAt: string | null }
interface InventoryEntry { paths?: string[]; recoveryId?: string; [key: string]: unknown }
const INVENTORY_CATEGORIES = ['duplicates', 'partialAlbums', 'orphanedSources', 'shadowedRecovery'] as const
// The agent's report: entry lists per category, plus fields the Worker adds or removes before answering.
type InventoryReport = Partial<Record<typeof INVENTORY_CATEGORIES[number] | 'dismissed', InventoryEntry[]>> & { completedAt?: string; checkedPaths?: Record<string, boolean>; missingD1Files?: unknown[] }

function parseInventoryTracklists(rows: Array<{ tracklistJson: string }> | null | undefined) {
  const tracklists: Array<{ tracks: unknown[] }> = []
  for (const row of rows || []) {
    try { const tracklist = JSON.parse(row.tracklistJson); if (tracklist && Array.isArray(tracklist.tracks)) tracklists.push(tracklist) } catch { /* ignore a corrupt cache row */ }
  }
  return tracklists
}
// D1 timestamps are UTC without a zone ('2026-10-16 19:50:00'); the agent's are ISO strings.
function inventoryTime(value: unknown): number {
  const text = String(value || '').trim()
  if (!text) return NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z')
}

// A record is only missing its file when a completed scan ran after it was imported: with no scan yet, or a scan
// older than the import, the inventory simply has not seen the file.
function inventoryMissingRows(rows: ImportedRow[], report: InventoryReport): ImportedRow[] {
  const scanned = inventoryTime(report?.completedAt)
  if (!Number.isFinite(scanned)) return []
  return rows.filter((row) => {
    if (report.checkedPaths?.[row.importedPath] !== false) return false
    const imported = inventoryTime(row.updatedAt)
    return !Number.isFinite(imported) || imported <= scanned
  })
}

// The album folder of an imported file, for records of wanted music that name only an artist.
function inventoryFolderName(path: string | null | undefined): string | null {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : null
}

function addInventoryLinks(report: InventoryReport, importedRows: ImportedRow[]) {
  const pathToRecovery = new Map(importedRows.map((row) => [row.importedPath, row.id]))
  for (const category of INVENTORY_CATEGORIES) {
    for (const entry of report?.[category] || []) {
      const recoveryId = (entry.paths || []).map((path) => pathToRecovery.get(path)).find(Boolean)
      if (recoveryId) entry.recoveryId = recoveryId
    }
  }
}

// Findings an administrator marked as fine are matched by category and their sorted paths, so a finding returns
// as soon as its files change.
function inventoryDismissible(category: string) { return (INVENTORY_CATEGORIES as readonly string[]).includes(category) }
function inventoryDismissalKey(paths: unknown[] | null | undefined) { return [...(paths || [])].map(String).sort().join('\n') }

function applyInventoryDismissals(report: InventoryReport, rows: DismissalRow[] | null | undefined) {
  const marked = new Map((rows || []).map((row) => [`${row.category}\0${row.pathsKey}`, row]))
  const dismissed: InventoryEntry[] = report.dismissed = []
  for (const category of INVENTORY_CATEGORIES) {
    const open: InventoryEntry[] = []
    for (const entry of report[category] || []) {
      const row = marked.get(`${category}\0${inventoryDismissalKey(entry.paths)}`)
      if (row) dismissed.push({ ...entry, category, dismissedBy: row.dismissedBy || null, dismissedAt: row.createdAt || null })
      else open.push(entry)
    }
    report[category] = open
  }
}

async function handleInventoryDismissal(request: Request, env: Env, username: string) {
  if (!env?.TOMIFY_DB) return json({ error: 'inventory-store-unavailable' }, 503)
  const body = await request.json<{ category?: unknown; paths?: unknown; restore?: unknown; label?: unknown }>().catch(() => ({} as Record<string, never>))
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
export async function handleInventoryRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/inventory\/(scan|status|summary|report|dismiss)$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can inspect the library inventory.' }, 403)
  try {
    if (match[1] === 'dismiss') return await handleInventoryDismissal(request, env, username)
    let payload = {}
    let importedRows: ImportedRow[] = []
    let dismissals: DismissalRow[] = []
    if (match[1] === 'report') {
      if (!env?.TOMIFY_DB) return json({ error: 'inventory-store-unavailable' }, 503)
      const [tracklistRows, recoveryRows, dismissalRows] = await Promise.all([
        env.TOMIFY_DB.prepare('SELECT tracklist_json AS tracklistJson FROM release_tracklists').all<{ tracklistJson: string }>(),
        env.TOMIFY_DB.prepare("SELECT i.id, i.artist, i.album, i.title, c.imported_path AS importedPath, c.updated_at AS updatedAt FROM recovery_items i JOIN recovery_candidates c ON c.recovery_id = i.id AND c.selected = 1 WHERE i.username = ? AND i.status IN ('recovered', 'needs-upgrade', 'imported') AND c.imported_path IS NOT NULL").bind(username).all<ImportedRow>(),
        env.TOMIFY_DB.prepare('SELECT category, paths_key AS pathsKey, dismissed_by AS dismissedBy, created_at AS createdAt FROM library_health_dismissals').all<DismissalRow>(),
      ])
      dismissals = dismissalRows.results || []
      importedRows = recoveryRows.results || []
      payload = { tracklists: parseInventoryTracklists(tracklistRows.results), checkPaths: importedRows.map((row) => row.importedPath) }
    }
    const result = await callRecoveryAgent(env, `/v1/inventory/${match[1]}`, payload)
    if (match[1] === 'report') {
      const report: InventoryReport = result?.report || {}
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
