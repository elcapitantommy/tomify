import { useEffect, useState } from 'react'
import { Activity, FolderSync, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/api-context'
import type { ScanStatus } from '../lib/navidrome'

export const SCAN_POLL_MS = 2000

export function LibraryScan() {
  const api = useApi()
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.scanStatus().then(setStatus).catch(() => setStatus(null)) }, [api])

  // Navidrome answers startScan straight away; follow it until the scan finishes.
  useEffect(() => {
    if (!status?.scanning) return
    const timer = setTimeout(() => { api.scanStatus().then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : 'Scan status is unavailable.')) }, SCAN_POLL_MS)
    return () => clearTimeout(timer)
  }, [api, status])

  async function scan() {
    setStarting(true)
    setError(null)
    try { setStatus(await api.startScan(true)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The library scan could not start.') }
    finally { setStarting(false) }
  }

  const scanning = starting || Boolean(status?.scanning)
  const detail = error ?? (scanning ? `Rescanning every file${status?.count ? ` · ${status.count.toLocaleString()} tracks so far` : ''}…`
    : `Rescans every file in the library, not just changed folders, so edited tags and artwork show up.${status?.lastScan ? ` Last scan ${new Date(status.lastScan).toLocaleString()}.` : ''}`)

  return <><Link className="setting-row setting-link-row" to="/library-health"><Activity/><span><strong>Library health</strong><small>Inspect duplicates, partial albums, orphaned sources and missing Recovery files.</small></span></Link><div className="setting-row"><FolderSync/><span><strong>Full library scan</strong><small role={error ? 'alert' : undefined}>{detail}</small></span>
    {scanning ? <button className="button secondary" disabled><LoaderCircle className="spin"/>Scanning…</button>
      : <button className="button secondary" onClick={() => void scan()}>Scan library</button>}
  </div></>
}
