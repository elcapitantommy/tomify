import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle, Play, RotateCw } from 'lucide-react'
import { NavidromeClient } from '../lib/navidrome'
import { RECOVERY_PLAYBACK_POLL_MS, type RecoveryItem } from '../lib/recovery'
import { recoveryApi } from '../lib/recovery-api'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'

/** Library scan state for an imported Recovery item: waiting for the scan, ready to play, or not found. */
export function RecoveryPlayback({ item, onItem }: { item: RecoveryItem; onItem(item: RecoveryItem): void }) {
  const playback = item.playback
  const [busy, setBusy] = useState<'play' | 'retry' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onItemRef = useRef(onItem)
  useEffect(() => { onItemRef.current = onItem }, [onItem])

  // Ask the Worker to look for the track when the page loads and then every 15 s; the Worker gives up after ten minutes.
  const pending = playback?.state === 'scan-pending'
  useEffect(() => {
    if (!pending) return
    let stopped = false
    let timer: number | undefined
    const check = async () => {
      try {
        const { item: updated } = await recoveryApi.checkPlayback(item.id)
        if (stopped) return
        onItemRef.current(updated)
        if (updated.playback?.state !== 'scan-pending') return
      } catch { if (stopped) return }
      timer = window.setTimeout(() => { void check() }, RECOVERY_PLAYBACK_POLL_MS)
    }
    void check()
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [item.id, pending, playback?.since])

  if (!playback) return null

  async function play() {
    const session = useAuth.getState().session
    if (!session || !playback?.songId) return
    setBusy('play'); setError(null)
    try { usePlayer.getState().playTracks([await new NavidromeClient(session).song(playback.songId)]) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The track could not be played.') }
    finally { setBusy(null) }
  }

  async function retry() {
    setBusy('retry'); setError(null)
    try { onItemRef.current((await recoveryApi.retryPlayback(item.id)).item) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The library scan could not be retried.') }
    finally { setBusy(null) }
  }

  return <div className={`recovery-playback ${playback.state}`}>
    {playback.state === 'scan-pending' && <><LoaderCircle className="spin"/><span>Imported, waiting for library scan</span></>}
    {playback.state === 'ready' && <><span>Ready to play</span><button className="button secondary" disabled={busy !== null} onClick={() => void play()} aria-label={`Play ${playback.target?.title || item.title}`}>{busy === 'play' ? <LoaderCircle className="spin"/> : <Play fill="currentColor"/>}Play</button></>}
    {playback.state === 'scan-failed' && <><AlertTriangle/><span>Not found in library after scan</span><button className="button secondary" disabled={busy !== null} onClick={() => void retry()}>{busy === 'retry' ? <LoaderCircle className="spin"/> : <RotateCw/>}Retry scan</button></>}
    {error && <small role="alert">{error}</small>}
  </div>
}
