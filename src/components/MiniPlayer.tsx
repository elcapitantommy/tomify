import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { PictureInPicture2 } from 'lucide-react'
import { Artwork } from './Artwork'
import { SeekBar, Transport, usePlaybackView } from './Player'
import { miniPlayerSupported, useMiniPlayer } from '../stores/miniPlayer'

// What the pop-out window shows: artwork, song, the usual transport and the seek bar.
// It controls whichever device is playing, like the player bar.
function MiniPlayer() {
  const view = usePlaybackView()
  const track = view.queue[view.currentIndex]
  if (!track) return <div className="mini-player empty"><p>Nothing playing</p></div>
  return <div className="mini-player">
    <Artwork id={track.coverArt ?? track.albumId} albumId={track.albumId} alt={track.album} size={300}/>
    <div className="mini-player-main">
      <div className="mini-player-copy"><strong title={track.title}>{track.title}</strong><small>{track.artist}{view.remote && view.deviceName ? ` · ${view.deviceName}` : ''}</small></div>
      <Transport/>
      <SeekBar/>
    </div>
  </div>
}

// Renders the mini player into its window while it is open, and keeps the window's theme in step with the page.
export function MiniPlayerHost() {
  const target = useMiniPlayer((state) => state.window)
  useEffect(() => {
    if (!target) return
    const root = document.documentElement
    const sync = () => target.document.documentElement.setAttribute('data-theme', root.getAttribute('data-theme') ?? 'dark')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [target])
  return target ? createPortal(<MiniPlayer/>, target.document.body) : null
}

// Player bar button (desktop Chrome and Edge only; other browsers don't have the window).
export function MiniPlayerButton() {
  const open = useMiniPlayer((state) => state.window !== null)
  if (!miniPlayerSupported()) return null
  const label = open ? 'Close mini player' : 'Pop out mini player'
  return <button type="button" className={`desktop-only${open ? ' active' : ''}`} onClick={() => open ? useMiniPlayer.getState().close() : void useMiniPlayer.getState().open().catch(() => undefined)} aria-label={label} title={label} aria-pressed={open}><PictureInPicture2/></button>
}
