import { useEffect, useRef, useState } from 'react'
import { ImageUp, LoaderCircle, Square } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { useAlbumArtwork, type ArtworkUpgradeProgress } from '../stores/albumArtwork'

function progressLabel(progress: ArtworkUpgradeProgress, running: boolean) {
  const parts = [`${progress.applied} upgraded`, progress.unchanged && `${progress.unchanged} already upgraded`, progress.noMatch && `${progress.noMatch} not found on Spotify`, progress.lowConfidence && `${progress.lowConfidence} uncertain matches left for the album page`, progress.failed && `${progress.failed} failed (${progress.lastError})`].filter(Boolean)
  const waiting = running && progress.waitingSeconds ? ` Spotify asked Tomify to slow down; resuming in ${progress.waitingSeconds}s.` : ''
  const stopped = progress.stopped ? ' Stopped after repeated Spotify errors.' : ''
  return `${running ? 'Checking' : 'Checked'} ${progress.done} of ${progress.total} albums: ${parts.join(', ')}.${waiting}${stopped}`
}

export function ArtworkUpgrade() {
  const api = useApi()
  const status = useAlbumArtwork((state) => state.status)
  const spotifyAvailable = useAlbumArtwork((state) => state.spotifyAvailable)
  const upgradeMany = useAlbumArtwork((state) => state.upgradeMany)
  const [progress, setProgress] = useState<ArtworkUpgradeProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const start = async () => {
    controller.current = new AbortController()
    setRunning(true); setError(null); setProgress(null)
    try { await upgradeMany(await api.allAlbums(controller.current.signal), setProgress, controller.current.signal) }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'The artwork upgrade stopped.') }
    finally { setRunning(false) }
  }

  const detail = error ?? (progress ? progressLabel(progress, running)
    : spotifyAvailable ? 'Replaces library artwork with a confident Spotify match of at least 600px. Albums where you chose artwork yourself are left alone, and nothing on the music server is changed.'
      : status === 'ready' ? 'Spotify is not configured on the server.' : 'The artwork store is unavailable.')

  return <div className="setting-row"><ImageUp/><span><strong>Upgrade album artwork from Spotify</strong><small>{detail}</small></span>
    {running ? <button className="button secondary" onClick={() => controller.current?.abort()}><Square/>Stop</button>
      : <button className="button secondary" disabled={!spotifyAvailable} onClick={() => void start()}>{progress ? 'Run again' : 'Upgrade'}</button>}
    {running && <LoaderCircle className="spin" aria-label="Upgrading artwork"/>}
  </div>
}
