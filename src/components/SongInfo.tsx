import { useEffect, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { Track } from '../types'
import { useApi } from '../lib/api-context'
import { isHiRes, qualityLabel, songDetails } from '../lib/song-info'

// A dialog with everything Navidrome knows about one song: format and quality, size, plays, credits and the file.
export function SongInfo({ track, onClose }: { track: Track; onClose: () => void }) {
  const api = useApi()
  const [full, setFull] = useState<Track | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api.song(track.id, controller.signal).then(setFull).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Song details could not be loaded.') })
    return () => controller.abort()
  }, [api, track.id])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  const song = full ? { ...track, ...full } : track
  return <div className="drawer-backdrop shortcuts-backdrop song-info-backdrop" onMouseDown={onClose}>
    <section className="shortcuts-help song-info" role="dialog" aria-modal="true" aria-label={`Song info: ${track.title}`} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2>{song.title}</h2><p>{song.artist}</p></div><button type="button" onClick={onClose} aria-label="Close song info" title="Close song info"><X/></button></header>
      <p className="song-quality">{isHiRes(song) && <span className="quality-badge hi-res">Hi-Res</span>}{qualityLabel(song)}</p>
      {!full && !error && <p className="song-info-loading"><LoaderCircle className="spin"/>Loading details…</p>}
      {error && <p className="song-info-error" role="alert">{error}</p>}
      <dl>{songDetails(song).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
  </div>
}
