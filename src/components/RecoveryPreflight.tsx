import { useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { recoveryApi } from '../lib/recovery-api'
import { preflightWarning, type RecoveryPreflight as Preflight, type RecoveryPreflightMode } from '../lib/recovery-preflight'

/** Duplicate check in the import confirmation: what Tom already has of this, and whether to skip those tracks. */
export function RecoveryPreflight({ itemId, mode, skipExisting, onSkipExistingChange }: { itemId: string; mode: RecoveryPreflightMode; skipExisting: boolean; onSkipExistingChange(value: boolean): void }) {
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setPreflight(null)
    // A failed check never blocks the import; it only means there is no warning to show.
    Promise.resolve().then(() => recoveryApi.preflight(itemId, mode))
      .then((result) => { if (!stopped) setPreflight(result) })
      .catch(() => undefined)
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true }
  }, [itemId, mode])

  if (loading) return <p className="recovery-preflight checking" role="status"><LoaderCircle className="spin"/>Checking what you already have…</p>
  const warning = preflightWarning(preflight)
  if (!warning) return null
  // Only a release import can leave out tracks; a single track is either imported or not.
  const canSkip = mode === 'release' && (preflight?.recovery?.length ?? 0) > 0
  return <div className="recovery-preflight" role="status"><AlertTriangle/><div><strong>{warning}</strong>{canSkip && <label><input type="checkbox" checked={skipExisting} onChange={(event) => onSkipExistingChange(event.target.checked)}/>Skip tracks I already have</label>}</div></div>
}
