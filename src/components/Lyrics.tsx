import { useEffect, useRef, useState } from 'react'
import { Loader2, MicVocal } from 'lucide-react'
import type { Track } from '../types'
import { useApi } from '../lib/api-context'
import { activeLine, loadLyrics, type Lyrics } from '../lib/lyrics'

// Lines light up a moment early, so the words are on screen as they are sung.
const LEAD_SECONDS = 0.25

interface Loaded { id: string; lyrics?: Lyrics | null; error?: string }

export function LyricsPanel({ track, time, onSeek }: { track: Track; time: number; onSeek?: (time: number) => void }) {
  const api = useApi()
  const [loaded, setLoaded] = useState<Loaded>({ id: track.id })
  const list = useRef<HTMLOListElement>(null)
  // Scrolling the lyrics yourself stops them following the song for a few seconds.
  const heldUntil = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoaded({ id: track.id })
    loadLyrics(api, track, controller.signal)
      .then((lyrics) => setLoaded({ id: track.id, lyrics }))
      .catch((error) => { if (!controller.signal.aborted) setLoaded({ id: track.id, error: error instanceof Error ? error.message : 'Lyrics are unavailable right now.' }) })
    return () => controller.abort()
  }, [api, track])

  const lyrics = loaded.id === track.id ? loaded.lyrics : undefined
  const active = lyrics?.synced ? activeLine(lyrics.lines, time + LEAD_SECONDS) : -1

  useEffect(() => {
    if (active < 0 || Date.now() < heldUntil.current) return
    const line = list.current?.children[active] as HTMLElement | undefined
    line?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [active])

  const hold = () => { heldUntil.current = Date.now() + 4000 }

  if (loaded.id === track.id && loaded.error) return <div className="lyrics-panel empty"><MicVocal/><p>{loaded.error}</p></div>
  if (lyrics === undefined) return <div className="lyrics-panel empty" aria-busy="true"><Loader2 className="spin"/><p>Finding lyrics…</p></div>
  if (!lyrics) return <div className="lyrics-panel empty"><MicVocal/><p>No lyrics found for this song.</p></div>

  return <div className="lyrics-panel" onWheel={hold} onTouchMove={hold}>
    <ol ref={list} className={lyrics.synced ? 'synced' : 'plain'} aria-label={`Lyrics for ${track.title}`}>
      {lyrics.lines.map((line, index) => <li key={index} className={index === active ? 'active' : index < active ? 'sung' : undefined} aria-current={index === active ? 'true' : undefined}>
        {lyrics.synced && onSeek && line.text ? <button type="button" onClick={() => onSeek(line.time)}>{line.text}</button> : line.text || ' '}
      </li>)}
    </ol>
    {!lyrics.synced && <small>These lyrics are not synced to the song.</small>}
  </div>
}
