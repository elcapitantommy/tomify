import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ExternalLink, FolderSearch, LoaderCircle, LockKeyhole, RefreshCw, Undo2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { InventoryUnavailableError, loadInventoryReport, loadInventoryStatus, setInventoryDismissal, startInventoryScan, type DismissedInventoryEntry, type InventoryCategory, type InventoryEntry, type InventoryReport, type InventoryStatus } from '../lib/inventory-api'
import { useAuth } from '../stores/auth'

const categories: Array<{ key: InventoryCategory; title: string; empty: string }> = [
  { key: 'duplicates', title: 'Duplicates and similar directories', empty: 'No duplicate recordings or similar directory names found.' },
  { key: 'partialAlbums', title: 'Partial albums', empty: 'No track-number gaps or incomplete cached editions found.' },
  { key: 'orphanedSources', title: 'Orphaned files and sidecars', empty: 'No orphaned provenance files found.' },
  { key: 'shadowedRecovery', title: 'Recovery copies shadowing masters', empty: 'No recovery copy duplicates a master recording.' },
  { key: 'missingD1Files', title: 'Recovery records with missing files', empty: 'Every imported Recovery record points to an inventoried file.' },
]

type EntryAction = { label: string; icon: typeof Check; run: (entry: InventoryEntry) => void }

function ReportCategory({ title, empty, entries, action, busy, open }: { title: string; empty: string; entries: InventoryEntry[]; action?: EntryAction; busy?: string | null; open?: boolean }) {
  return <details className="health-category" open={open ?? entries.length > 0}><summary><span>{title}</span><strong>{entries.length}</strong></summary>
    {entries.length === 0 ? <p className="health-empty">{empty}</p> : <ul>{entries.map((entry, index) => {
      const link = entry.albumId ? `/albums/${encodeURIComponent(entry.albumId)}` : entry.recoveryId ? `/recovery?item=${encodeURIComponent(entry.recoveryId)}` : null
      const key = entryKey(entry)
      const Icon = action?.icon
      return <li key={`${key}-${index}`}><div><strong>{entry.label}</strong>{entry.expectedTracks ? <small>{entry.actualTracks} of {entry.expectedTracks} tracks inventoried</small> : null}</div>
        <span className="health-actions">{link && <Link to={link} aria-label={`Open ${entry.label}`}><ExternalLink/></Link>}{action && Icon && <button className="button secondary" disabled={busy === key} aria-label={`${action.label}: ${entry.label}`} onClick={() => action.run(entry)}>{busy === key ? <LoaderCircle className="spin"/> : <Icon/>}{action.label}</button>}</span>
        <code>{entry.paths.join('\n')}</code>{entry.missingPath && <small>Missing: {entry.missingPath}</small>}</li>
    })}</ul>}
  </details>
}

function entryKey(entry: InventoryEntry) { return `${entry.kind}:${[...entry.paths].sort().join('|')}` }

export function LibraryHealth() {
  const isAdmin = useAuth((state) => state.isAdmin)
  const [report, setReport] = useState<InventoryReport | null>(null)
  const [status, setStatus] = useState<InventoryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outdated, setOutdated] = useState(false)
  const load = useCallback(async () => {
    try { const [nextReport, nextStatus] = await Promise.all([loadInventoryReport(), loadInventoryStatus()]); setReport(nextReport); setStatus(nextStatus); setError(null); setOutdated(false) }
    catch (cause) { if (cause instanceof InventoryUnavailableError) setOutdated(true); else setError(cause instanceof Error ? cause.message : 'Library health is unavailable.') }
  }, [])
  useEffect(() => { if (isAdmin === true) void load() }, [isAdmin, load])
  useEffect(() => {
    if (status?.state !== 'running') return
    const timer = window.setTimeout(async () => {
      try { const next = await loadInventoryStatus(); setStatus(next); if (next.state === 'completed') await load() }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Scan progress is unavailable.') }
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [status, load])
  const [busy, setBusy] = useState<string | null>(null)
  const mark = async (category: InventoryCategory, entry: InventoryEntry, restore: boolean) => {
    setBusy(entryKey(entry))
    try { await setInventoryDismissal(category, entry, restore); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The finding could not be updated.') }
    finally { setBusy(null) }
  }
  const scan = async () => {
    try { const result = await startInventoryScan(); setStatus(result.status); setError(null) }
    catch (cause) { if (cause instanceof InventoryUnavailableError) setOutdated(true); else setError(cause instanceof Error ? cause.message : 'The scan could not be started.') }
  }

  if (isAdmin !== true) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Library</span><h1>Library health</h1><p>{isAdmin === null ? 'Checking your account…' : 'Library health is only available to Navidrome administrators.'}</p></header>{isAdmin === false && <section className="state-card"><LockKeyhole/><h2>Administrator access required</h2></section>}</div>
  if (outdated) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Library</span><h1>Library health</h1></header><section className="state-card"><AlertTriangle/><h2>Recovery agent update needed</h2><p>Redeploy the recovery agent to enable library health reports.</p></section></div>
  if (!report && !error) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Library</span><h1>Library health</h1></header><section className="state-card"><LoaderCircle className="spin"/><h2>Checking the inventory…</h2></section></div>

  return <div className="page narrow-page"><header className="page-header health-header"><div><span className="eyebrow">Library</span><h1>Library health</h1><p>Read-only checks from the last stored inventory. Nothing here deletes, moves or merges files.</p></div><button className="button primary" disabled={status?.state === 'running'} onClick={() => void scan()}>{status?.state === 'running' ? <LoaderCircle className="spin"/> : <RefreshCw/>}{status?.state === 'running' ? `Scanning ${status.progress}%` : 'Scan now'}</button></header>
    {error && <div className="login-error" role="alert">{error}</div>}
    <section className="health-scan"><FolderSearch/><span><strong>{report?.completedAt ? `Last scanned ${new Date(report.completedAt).toLocaleString()}` : 'No completed inventory scan'}</strong><small>{status?.state === 'running' ? `${status.filesProcessed} of ${status.filesDiscovered || '…'} files checked` : 'Reports do not start a filesystem scan.'}</small></span></section>
    {report && categories.map((category) => <ReportCategory key={category.key} title={category.title} empty={category.empty} entries={report[category.key] || []} busy={busy}
      action={category.key === 'missingD1Files' ? undefined : { label: 'Mark as fine', icon: Check, run: (entry) => void mark(category.key, entry, false) }}/>)}
    {report?.dismissed && report.dismissed.length > 0 && <ReportCategory title="Marked as fine" empty="" entries={report.dismissed} busy={busy} open={false}
      action={{ label: 'Report again', icon: Undo2, run: (entry) => void mark((entry as DismissedInventoryEntry).category, entry, true) }}/>}
  </div>
}
