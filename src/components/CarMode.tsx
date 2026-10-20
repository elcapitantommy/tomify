import { useEffect } from 'react'
import { Pause, Play, Shuffle, SkipBack, SkipForward, X } from 'lucide-react'
import { Artwork } from './Artwork'
import { StarButton } from './StarButton'
import { usePlaybackView } from './Player'
import { formatDuration } from '../lib/format'
import { keepScreenOn } from '../lib/wakeLock'
import { useCarMode } from '../stores/carMode'
import { usePlayer } from '../stores/player'

// A Now Playing screen for the car: big targets, big text, nothing small to aim for, and the screen kept on.
// It controls whichever device is playing, like the rest of the player.
export function CarMode() {
  const open = useCarMode((state) => state.open)
  const setOpen = useCarMode((state) => state.setOpen)
  const player = usePlayer()
  const view = usePlaybackView()
  const track = view.queue[view.currentIndex]

  useEffect(() => (open && track ? keepScreenOn() : undefined), [open, Boolean(track)]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !track) return null
  const togglePlaying = () => view.remote ? view.command(view.playing ? 'pause' : 'play') : player.setPlaying(!player.playing)
  const previous = () => view.remote ? view.command('previous') : player.previous()
  const next = () => view.remote ? view.command('next') : player.next()
  const shuffle = () => view.remote ? view.command('toggle-shuffle') : player.toggleShuffle()
  const progress = view.duration > 0 ? Math.min(100, (view.currentTime / view.duration) * 100) : 0

  return <section className="car-mode" role="dialog" aria-modal="true" aria-label="Car mode">
    <header><span>Car mode{view.remote && view.deviceName ? ` · ${view.deviceName}` : ''}</span><button type="button" className="car-exit" onClick={() => setOpen(false)} aria-label="Leave car mode"><X/>Exit</button></header>
    <div className="car-now"><Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={600}/><div><h1>{track.title}</h1><p>{track.artist}</p></div></div>
    <div className="car-progress" aria-hidden="true"><span style={{ width: `${progress}%` }}/></div>
    <div className="car-times"><span>{formatDuration(view.currentTime)}</span><span>{formatDuration(view.duration)}</span></div>
    <div className="car-controls"><button type="button" onClick={previous} aria-label="Previous track"><SkipBack fill="currentColor"/></button><button type="button" className="car-play" onClick={togglePlaying} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button type="button" onClick={next} aria-label="Next track"><SkipForward fill="currentColor"/></button></div>
    <div className="car-extras"><button type="button" className={view.shuffle ? 'active' : ''} onClick={shuffle} aria-label="Shuffle" aria-pressed={view.shuffle}><Shuffle/>Shuffle</button><StarButton item={track} kind="song" name={track.title} className="car-like"/></div>
  </section>
}
