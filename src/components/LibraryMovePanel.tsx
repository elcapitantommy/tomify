import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, MoveRight, Undo2 } from 'lucide-react'
import type { InventoryEntry } from '../lib/inventory-api'
import { applyLibraryMove, matchSongIds, navidrome, planLibraryMove, relinkMap, relinkOwnPlaylists, rescanNavidrome, type LibraryMoveJournal, type LibraryMovePlan, type LibraryMoveRequest } from '../lib/library-moves-api'

const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function Choice({ name, paths, value, onChange, legend }: { name: string; paths: string[]; value: string; onChange: (path: string) => void; legend: string }) {
  return <fieldset className="health-choice"><legend>{legend}</legend>{paths.map((path) => <label key={path}><input type="radio" name={name} checked={value === path} onChange={() => onChange(path)}/><code>{path}</code></label>)}</fieldset>
}

// A merge keeps one copy and moves the others to _Duplicates; a promotion swaps a Recovery copy in for its master.
// The planned moves come from the agent before anything changes, and the button applies exactly that plan.
export function LibraryMovePanel({ entry, promote, onDone, onCancel }: { entry: InventoryEntry; promote: boolean; onDone: (journal: LibraryMoveJournal, notice: string) => void; onCancel: () => void }) {
  const masters = entry.masterPaths ?? []
  const recoveries = entry.recoveryPaths ?? []
  const [keep, setKeep] = useState(entry.paths[0])
  const [master, setMaster] = useState(masters[0] ?? '')
  const [recovery, setRecovery] = useState(recoveries[0] ?? '')
  const move = useMemo<LibraryMoveRequest>(() => promote ? { kind: 'promote', master, recovery, label: entry.label } : { kind: 'merge', keep, paths: entry.paths, label: entry.label }, [promote, master, recovery, keep, entry])
  const [plan, setPlan] = useState<LibraryMovePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setPlan(null)
    setError(null)
    planLibraryMove(move).then((next) => { if (live) setPlan(next) }, (cause) => { if (live) setError(message(cause, 'The move could not be planned.')) })
    return () => { live = false }
  }, [move])

  const confirm = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    const api = navidrome()
    // Song ids are looked up before anything moves, while Navidrome still lists every copy.
    let relink: Record<string, string> = {}
    try { if (api) relink = relinkMap(move, await matchSongIds(api, entry.label, plan.sizes)) } catch { /* relinking is best effort */ }
    try {
      const { journal } = await applyLibraryMove(move, relink)
      let playlists = 0
      try { if (api) playlists = await relinkOwnPlaylists(api, relink) } catch { /* the files have moved; playlists can be fixed by hand */ }
      await rescanNavidrome()
      const relinked = Object.keys(relink).length ? ` Pointed ${plural(Object.keys(relink).length, 'song')} at the kept copy in imported playlists and ${playlists} of your Navidrome playlists.` : ''
      onDone(journal, `Moved ${plural(journal.moves.length, 'item')}.${relinked} Scan again to refresh this report.`)
    } catch (cause) {
      setError(message(cause, 'The move failed.'))
      setBusy(false)
    }
  }

  return <div className="health-move">
    {promote
      ? <>{masters.length > 1 && <Choice name={`master-${entry.label}`} legend="Master to replace" paths={masters} value={master} onChange={setMaster}/>}
        {recoveries.length > 1 && <Choice name={`recovery-${entry.label}`} legend="Recovery copy to promote" paths={recoveries} value={recovery} onChange={setRecovery}/>}
        <p>The Recovery copy takes the master's place under the master's name. The master moves to <code>_Duplicates</code>, which Navidrome ignores.</p></>
      : <><Choice name={`keep-${entry.label}`} legend="Copy to keep" paths={entry.paths} value={keep} onChange={setKeep}/>
        <p>The other {entry.kind === 'directory' ? 'folders, with everything in them,' : 'copies'} move to <code>_Duplicates</code>, which Navidrome ignores.</p></>}
    {error && <div className="login-error" role="alert">{error}</div>}
    {!plan && !error && <p className="health-empty"><LoaderCircle className="spin"/> Planning…</p>}
    {plan && <><strong>Planned moves</strong><ol className="health-moves">{plan.moves.map((item) => <li key={item.from}><code>{item.path || item.from}</code><MoveRight/><code>{item.to}</code></li>)}</ol>
      {plan.conflicts.length > 0 && <div className="login-error" role="alert">Something already exists at {plan.conflicts.join(', ')}. Move it away first.</div>}</>}
    <p className="health-empty">Nothing is deleted, and Recent moves can undo this.</p>
    <span className="health-actions"><button className="button primary" disabled={!plan || plan.conflicts.length > 0 || busy} onClick={() => void confirm()}>{busy ? <LoaderCircle className="spin"/> : <MoveRight/>}{promote ? 'Promote' : 'Merge'}</button><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button></span>
  </div>
}

const statusText: Record<LibraryMoveJournal['status'], string> = { applying: 'Interrupted', applied: 'Applied', 'rolled-back': 'Failed and put back', undone: 'Undone' }

export function RecentMoves({ moves, busy, onUndo }: { moves: LibraryMoveJournal[]; busy: string | null; onUndo: (journal: LibraryMoveJournal) => void }) {
  return <details className="health-category" open={moves.length > 0}><summary><span>Recent moves</span><strong>{moves.length}</strong></summary>
    {moves.length === 0 ? <p className="health-empty">No merges or promotions yet.</p> : <ul>{moves.map((journal) => <li key={journal.id}>
      <div><strong>{journal.label || (journal.kind === 'promote' ? 'Promotion' : 'Merge')}</strong><small>{statusText[journal.status] ?? journal.status} · {new Date(journal.createdAt).toLocaleString()}{journal.error ? ` · ${journal.error}` : ''}</small></div>
      <span className="health-actions">{journal.status === 'applied' && <button className="button secondary" disabled={busy === journal.id} aria-label={`Undo: ${journal.label || journal.id}`} onClick={() => onUndo(journal)}>{busy === journal.id ? <LoaderCircle className="spin"/> : <Undo2/>}Undo</button>}</span>
      <code>{journal.moves.map((item) => `${item.path || item.from} → ${item.to}`).join('\n')}</code></li>)}</ul>}
  </details>
}
