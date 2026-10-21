import { SAVE_EVERY_SECONDS, bookmarkActionAt, isLongTrack, resumePosition } from './long-tracks'
import { useBookmarks, type BookmarkApi } from '../stores/bookmarks'
import { usePlayer, type PlayerState } from '../stores/player'

const currentOf = (state: PlayerState) => state.queue[state.currentIndex]

// Follows this device's player: saves the place in a long track every 30 seconds, on pause and when the
// song changes, forgets it once the track is finished, and seeks to a saved place when a long track starts.
// Returns a function that stops following.
export function followPlayer(api: BookmarkApi) {
  let pending: { trackId: string; position: number } | null = null
  let lastSaved: { trackId: string; position: number } | null = null

  const record = (trackId: string, position: number, duration?: number) => {
    const action = bookmarkActionAt(position, duration)
    if (!action) return
    if (action.kind === 'clear') { void useBookmarks.getState().clear(api, trackId).catch(() => undefined); return }
    lastSaved = { trackId, position: action.position }
    void useBookmarks.getState().save(api, trackId, action.position).catch(() => undefined)
  }

  const unsubscribe = usePlayer.subscribe((state, previous) => {
    const track = currentOf(state)
    const before = currentOf(previous)
    if (track?.id !== before?.id) {
      // Leaving a long track: keep its place, or forget it if it finished.
      if (before && isLongTrack(before.duration)) record(before.id, previous.currentTime, before.duration)
      pending = null
      const saved = track ? resumePosition(useBookmarks.getState().positions[track.id], track.duration) : null
      if (track && saved !== null && state.currentTime < 5) pending = { trackId: track.id, position: saved }
      return
    }
    if (!track || !isLongTrack(track.duration)) return
    // Seek once the new song is really playing, so the jump lands on the right audio element.
    if (pending?.trackId === track.id && state.currentTime > 0) {
      const { position } = pending
      pending = null
      if (state.currentTime < position - 5) { state.seekTo(position); return }
    }
    if (previous.playing && !state.playing) { record(track.id, state.currentTime, track.duration); return }
    if (state.playing && Math.abs(state.currentTime - (lastSaved?.trackId === track.id ? lastSaved.position : 0)) >= SAVE_EVERY_SECONDS) record(track.id, state.currentTime, track.duration)
  })

  const leaving = () => {
    const state = usePlayer.getState()
    const track = currentOf(state)
    if (track && isLongTrack(track.duration)) record(track.id, state.currentTime, track.duration)
  }
  window.addEventListener('pagehide', leaving)
  return () => { unsubscribe(); window.removeEventListener('pagehide', leaving) }
}
