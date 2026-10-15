import { ImageUp, LoaderCircle, Square } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { upgradeIntervalMs, useAlbumArtwork, type ArtworkUpgradeProgress } from '../stores/albumArtwork'

function progressLabel(progress: ArtworkUpgradeProgress, running: boolean) {
  const parts = [`${progress.applied} upgraded`, progress.unchanged && `${progress.unchanged} already upgraded`, progress.noMatch && `${progress.noMatch} not found`, progress.lowConfidence && `${progress.lowConfidence} uncertain matches left for the album page`, progress.failed && `${progress.failed} failed (${progress.lastError})`].filter(Boolean)
  const waiting = running && progress.waitingSeconds ? ` A catalogue asked Tomify to slow down; resuming in ${progress.waitingSeconds}s.` : ''
  const stopped = progress.stopped ? ' Stopped after repeated catalogue errors.' : ''
  const remaining = running ? Math.ceil((progress.total - progress.done) * upgradeIntervalMs / 60_000) : 0
  const eta = running && remaining > 1 ? ` About ${remaining} minutes left; you can keep using Tomify meanwhile.` : ''
  return `${running ? 'Checking' : 'Checked'} ${progress.done} of ${progress.total} albums: ${parts.join(', ')}.${waiting}${stopped}${eta}`
}

export function ArtworkUpgrade() {
  const api = useApi()
  const status = useAlbumArtwork((state) => state.status)
  const providers = useAlbumArtwork((state) => state.providers)
  const { running, progress, error } = useAlbumArtwork((state) => state.upgrade)
  const startUpgrade = useAlbumArtwork((state) => state.startUpgrade)
  const stopUpgrade = useAlbumArtwork((state) => state.stopUpgrade)
  const available = status === 'ready' && providers.length > 0
  const sources = providers.map((provider) => ({ apple: 'Apple', deezer: 'Deezer', spotify: 'Spotify' })[provider]).join(', then ')

  const detail = error ?? (progress ? progressLabel(progress, running)
    : available ? `Replaces library artwork with a confident square match of at least 600px from ${sources}. Albums where you chose artwork yourself are left alone, and nothing on the music server is changed.`
      : 'The artwork store is unavailable.')

  return <div className="setting-row"><ImageUp/><span><strong>Upgrade album artwork</strong><small>{detail}</small></span>
    {running ? <button className="button secondary" onClick={stopUpgrade}><Square/>Stop</button>
      : <button className="button secondary" disabled={!available} onClick={() => void startUpgrade((signal) => api.allAlbums(signal))}>{progress ? 'Run again' : 'Upgrade'}</button>}
    {running && <LoaderCircle className="spin" aria-label="Upgrading artwork"/>}
  </div>
}
