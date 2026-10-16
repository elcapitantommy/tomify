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

// Admin-only access to the recovery agent's read-only inventory. An older agent answers 404;
// expose that as unavailable rather than an agent or contract failure.
async function handleInventoryRequest(request, env, url) {
  const match = url.pathname.match(/^\/api\/inventory\/(scan|status|summary|report)$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can inspect the library inventory.' }, 403)
  try {
    let payload = {}
    let importedRows = []
    if (match[1] === 'report') {
      if (!env?.TOMIFY_DB) return json({ error: 'inventory-store-unavailable' }, 503)
      const [tracklistRows, recoveryRows] = await Promise.all([
        env.TOMIFY_DB.prepare('SELECT tracklist_json AS tracklistJson FROM release_tracklists').all(),
        env.TOMIFY_DB.prepare("SELECT i.id, i.artist, i.album, i.title, c.imported_path AS importedPath, c.updated_at AS updatedAt FROM recovery_items i JOIN recovery_candidates c ON c.recovery_id = i.id AND c.selected = 1 WHERE i.username = ? AND i.status IN ('recovered', 'needs-upgrade', 'imported') AND c.imported_path IS NOT NULL").bind(username).all(),
      ])
      importedRows = recoveryRows.results || []
      payload = { tracklists: parseInventoryTracklists(tracklistRows.results), checkPaths: importedRows.map((row) => row.importedPath) }
    }
    const result = await callRecoveryAgent(env, `/v1/inventory/${match[1]}`, payload)
    if (match[1] === 'report') {
      const report = result?.report || {}
      addInventoryLinks(report, importedRows)
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

export const inventoryWorkerSource = [parseInventoryTracklists, inventoryTime, inventoryMissingRows, inventoryFolderName, addInventoryLinks, handleInventoryRequest].map((value) => value.toString()).join('\n\n')
