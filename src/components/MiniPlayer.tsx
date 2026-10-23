import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, PictureInPicture2 } from 'lucide-react'
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
  const compact = useMiniPlayer((state) => state.compact)
  useEffect(() => {
    if (!compact) return
    document.body.classList.add('mini-player-window')
    return () => document.body.classList.remove('mini-player-window')
  }, [compact])
  // Signing out leaves Tomify's player behind; give the Windows app its full window back.
  useEffect(() => () => { if (useMiniPlayer.getState().compact) useMiniPlayer.getState().close() }, [])
  useEffect(() => {
    if (!target) return
    const root = document.documentElement
    const sync = () => target.document.documentElement.setAttribute('data-theme', root.getAttribute('data-theme') ?? 'dark')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [target])
  // The Windows app's window is the mini player: drag it anywhere that isn't a control.
  if (compact) {
    const close = () => useMiniPlayer.getState().close()
    return <div className="desktop-mini-player" data-tauri-drag-region="deep"><MiniPlayer/><button type="button" className="desktop-mini-expand" onClick={close} aria-label="Back to full window" title="Back to full window"><Maximize2/></button></div>
  }
  return target ? createPortal(<MiniPlayer/>, target.document.body) : null
}

// Player bar button (desktop Chrome and Edge, and the Windows app; other browsers don't have the window).
export function MiniPlayerButton() {
  const open = useMiniPlayer((state) => state.window !== null || state.compact)
  if (!miniPlayerSupported()) return null
  const label = open ? 'Close mini player' : 'Pop out mini player'
  return <button type="button" className={`desktop-only${open ? ' active' : ''}`} onClick={() => open ? useMiniPlayer.getState().close() : void useMiniPlayer.getState().open().catch(() => undefined)} aria-label={label} title={label} aria-pressed={open}><PictureInPicture2/></button>
}
