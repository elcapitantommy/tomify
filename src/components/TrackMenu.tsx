import { useEffect, useRef, useState } from 'react'
import { Info, ListEnd, ListStart, MoreHorizontal } from 'lucide-react'
import type { Track } from '../types'
import { addToQueueAnywhere, playNextAnywhere } from '../stores/playbackHandoff'
import { SongInfo } from './SongInfo'

// The "more" button on a song row: Play next, Add to queue and Song info. One button keeps phone rows uncrowded.
export function TrackMenu({ track }: { track: Track }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape) }
  }, [open])

  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => setDone(null), 2500)
    return () => window.clearTimeout(timer)
  }, [done])

  const act = (run: () => void, message: string) => { run(); setOpen(false); setDone(message) }

  return <div className="track-menu" ref={container}>
    <button type="button" className="icon-button" onClick={() => setOpen(!open)} aria-label={`More for ${track.title}`} aria-expanded={open} aria-haspopup="menu" title="More"><MoreHorizontal/></button>
    {open && <div className="add-to-playlist-menu track-menu-list" role="menu" aria-label={`${track.title} options`}>
      <button type="button" role="menuitem" onClick={() => act(() => playNextAnywhere([track]), 'Playing next')}><ListStart/><span>Play next</span></button>
      <button type="button" role="menuitem" onClick={() => act(() => addToQueueAnywhere(track), 'Added to queue')}><ListEnd/><span>Add to queue</span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); setInfo(true) }}><Info/><span>Song info</span></button>
    </div>}
    {done && <span className="track-menu-done" role="status">{done}</span>}
    {info && <SongInfo track={track} onClose={() => setInfo(false)}/>}
  </div>
}

// Play next for a whole album or playlist, shown beside Play and Shuffle.
export function PlayNextButton({ tracks, label }: { tracks: Track[]; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => setDone(false), 2500)
    return () => window.clearTimeout(timer)
  }, [done])
  return <button type="button" className="button secondary" disabled={!tracks.length} onClick={() => { playNextAnywhere(tracks); setDone(true) }} aria-label={`Play ${label} next`} title="Play next">
    <ListStart/>{done ? 'Playing next' : 'Play next'}
  </button>
}
