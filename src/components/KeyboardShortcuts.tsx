import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useOptionalApi } from '../lib/api-context'
import { isTypingTarget, seekTarget, SHORTCUT_HELP, shortcutFor, stepVolume, type ShortcutAction } from '../lib/shortcuts'
import { controlRemote, currentRemoteSession, livePosition, serverNow } from '../stores/livePlayback'
import { usePlayer } from '../stores/player'
import { isStarred, useFavourites } from '../stores/favourites'
import type { NavidromeClient } from '../lib/navidrome'

// Playback shortcuts act on whichever device is playing, like the player bar's buttons do.
function runPlayback(action: ShortcutAction) {
  const remote = currentRemoteSession()
  const player = usePlayer.getState()
  if (remote) {
    const position = livePosition(remote, serverNow())
    switch (action) {
      case 'toggle-play': return controlRemote(remote, remote.playing ? 'pause' : 'play')
      case 'next': return controlRemote(remote, 'next')
      case 'previous': return controlRemote(remote, 'previous')
      case 'seek-forward': return controlRemote(remote, 'seek', seekTarget(position, remote.duration, 1))
      case 'seek-back': return controlRemote(remote, 'seek', seekTarget(position, remote.duration, -1))
      case 'volume-up': return controlRemote(remote, 'set-volume', stepVolume(remote.volume, 1))
      case 'volume-down': return controlRemote(remote, 'set-volume', stepVolume(remote.volume, -1))
      case 'mute': return controlRemote(remote, 'toggle-muted')
      case 'shuffle': return controlRemote(remote, 'toggle-shuffle')
      case 'repeat': return controlRemote(remote, 'cycle-repeat')
      default: return
    }
  }
  if (!player.queue[player.currentIndex]) return
  switch (action) {
    case 'toggle-play': return player.setPlaying(!player.playing)
    case 'next': return player.next()
    case 'previous': return player.previous()
    case 'seek-forward': return player.seekTo(seekTarget(player.currentTime, player.duration, 1))
    case 'seek-back': return player.seekTo(seekTarget(player.currentTime, player.duration, -1))
    case 'volume-up': return player.setVolume(stepVolume(player.volume, 1))
    case 'volume-down': return player.setVolume(stepVolume(player.volume, -1))
    case 'mute': return player.toggleMuted()
    case 'shuffle': return player.toggleShuffle()
    case 'repeat': return player.cycleRepeat()
    default: return
  }
}

async function toggleLike(api: NavidromeClient | null) {
  const remote = currentRemoteSession()
  const player = usePlayer.getState()
  const track = remote ? remote.queue[remote.currentIndex] : player.queue[player.currentIndex]
  if (!api || !track) return
  const favourites = useFavourites.getState()
  const starred = isStarred(favourites.overrides, track)
  favourites.setStarred(track.id, !starred)
  try {
    await (starred ? api.unstar(track.id) : api.star(track.id))
    useFavourites.getState().confirm()
  } catch (error) {
    console.error('Could not update favourite', error)
    useFavourites.getState().setStarred(track.id, starred)
  }
}

export function KeyboardShortcuts() {
  const api = useOptionalApi()
  const navigate = useNavigate()
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat && event.key === ' ') return
      if (isTypingTarget(event.target)) return
      const action = shortcutFor(event)
      if (!action) return
      event.preventDefault()
      const player = usePlayer.getState()
      switch (action) {
        case 'help': setHelpOpen((open) => !open); return
        case 'search': {
          const box = document.querySelector<HTMLInputElement>('.search-box input')
          if (box) box.focus()
          else navigate('/search')
          return
        }
        case 'now-playing': player.setNowPlayingOpen(!player.nowPlayingOpen); return
        case 'queue': player.setQueueOpen(!player.queueOpen); return
        case 'like': void toggleLike(api); return
        default: runPlayback(action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, navigate])

  useEffect(() => {
    if (!helpOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [helpOpen])

  if (!helpOpen) return null
  return <div className="drawer-backdrop shortcuts-backdrop" onMouseDown={() => setHelpOpen(false)}>
    <section className="shortcuts-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>Keyboard shortcuts</h2><button type="button" onClick={() => setHelpOpen(false)} aria-label="Close keyboard shortcuts"><X/></button></header>
      <dl>{SHORTCUT_HELP.map((item) => <div key={item.label}><dt>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt><dd>{item.label}</dd></div>)}</dl>
    </section>
  </div>
}
