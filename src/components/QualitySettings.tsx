import { useEffect, useState } from 'react'
import { AudioLines, LoaderCircle, RefreshCw } from 'lucide-react'
import type { QualityTarget } from '../../shared/quality.mjs'
import { qualityApi, type QualityRecheck, type QualitySettings as Settings } from '../lib/quality-api'

function recheckSummary(result: QualityRecheck) {
  if (!result.changed) return `Checked ${result.checked} recovered item${result.checked === 1 ? '' : 's'}; every label was already right.`
  const parts = [result.recovered ? `${result.recovered} now recovered` : null, result.needsUpgrade ? `${result.needsUpgrade} now need an upgrade` : null].filter(Boolean)
  return `Checked ${result.checked} item${result.checked === 1 ? '' : 's'}: ${parts.join(', ')}.`
}

/** Settings section for the recovery quality target. Administrators only (Settings is admin-only). */
export function QualitySettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { qualityApi.get().then(setSettings).catch((reason) => setError(reason instanceof Error ? reason.message : 'Quality settings are unavailable.')) }, [])

  async function change(target: QualityTarget) {
    setSaving(true); setError(null); setMessage(null)
    try { setSettings(await qualityApi.setTarget(target)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The quality target could not be saved.') }
    finally { setSaving(false) }
  }

  async function recheck() {
    setRechecking(true); setError(null); setMessage(null)
    try { setMessage(recheckSummary(await qualityApi.recheck())) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The quality labels could not be re-checked.') }
    finally { setRechecking(false) }
  }

  const selected = settings?.targets.find((option) => option.id === settings.target)
  return <section className="settings-card quality-settings"><h2>Recovery quality</h2>
    <div className="setting-row"><AudioLines/><label htmlFor="quality-target"><strong>Preferred quality</strong><small>{selected ? `New imports below this are marked Needs upgrade. ${selected.description}.` : 'Loading…'}</small></label>
      <select id="quality-target" value={settings?.target ?? ''} disabled={!settings || saving} onChange={(event) => void change(event.target.value as QualityTarget)}>
        {!settings && <option value="">Loading…</option>}
        {settings?.targets.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </div>
    <div className="setting-row"><RefreshCw/><span><strong>Re-check quality labels</strong><small role={error ? 'alert' : undefined}>{error ?? message ?? 'Recomputes Recovered and Needs upgrade for items already imported, from the source quality stored at import. Items you marked acceptable by hand are checked too.'}</small></span>
      {rechecking ? <button className="button secondary" disabled><LoaderCircle className="spin"/>Checking…</button>
        : <button className="button secondary" disabled={!settings} onClick={() => void recheck()}>Re-check</button>}
    </div>
  </section>
}
