import { useAuth } from '../stores/auth'
import type { Track } from '../types'

// Tomify keeps its own listening history (Navidrome only keeps a play count per song) so mixes know
// what you play, when, and what you skip. Each play is sent once the track finishes or you move on.

export interface ListeningEvent {
  trackId: string
  albumId?: string
  artistId?: string
  title: string
  artist: string
  album: string
  durationSeconds?: number
  listenedSeconds: number
  completed: boolean
  skipped: boolean
  playedAt: number
  device?: string
}

// Under this many seconds a track counts as never really played (a quick flick past it).
export const MIN_LISTEN_SECONDS = 5
// Moving on before this much of a track (or 30 seconds, whichever is less) counts as a skip.
export const SKIP_FRACTION = 0.5
const SKIP_MAX_SECONDS = 30
// Time updates further apart than this are a seek, not listening.
const MAX_TICK_SECONDS = 2.5
const PENDING_KEY = 'tomify.listening.pending'
const MAX_PENDING = 200

export class ListeningTracker {
  private current: { track: Track; startedAt: number; listened: number; lastTime: number | null; duration?: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  get trackId() { return this.current?.track.id }

  begin(track: Track) {
    if (this.current?.track.id === track.id) return
    this.current = { track, startedAt: this.now(), listened: 0, lastTime: null, duration: track.duration }
  }

  progress(currentTime: number, duration: number, playing: boolean) {
    const current = this.current
    if (!current) return
    if (Number.isFinite(duration) && duration > 0) current.duration = duration
    if (playing && current.lastTime !== null) {
      const delta = currentTime - current.lastTime
      if (delta > 0 && delta <= MAX_TICK_SECONDS) current.listened += delta
    }
    current.lastTime = currentTime
  }

  // Ends the current play and returns its event, or null if it was too short to count.
  finish(completed: boolean, device?: string): ListeningEvent | null {
    const current = this.current
    this.current = null
    if (!current || current.listened < MIN_LISTEN_SECONDS) return null
    const duration = current.duration && Number.isFinite(current.duration) ? current.duration : undefined
    const skipAt = duration ? Math.min(duration * SKIP_FRACTION, SKIP_MAX_SECONDS) : SKIP_MAX_SECONDS
    const { track } = current
    return {
      trackId: track.id,
      albumId: track.albumId,
      artistId: track.artistId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: duration ? Math.round(duration) : undefined,
      listenedSeconds: Math.round(current.listened),
      completed,
      skipped: !completed && current.listened < skipAt,
      playedAt: current.startedAt,
      device,
    }
  }
}

function readPending(): ListeningEvent[] {
  try { const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]'); return Array.isArray(value) ? value : [] } catch { return [] }
}
function writePending(events: ListeningEvent[]) {
  try { if (events.length) localStorage.setItem(PENDING_KEY, JSON.stringify(events.slice(-MAX_PENDING))); else localStorage.removeItem(PENDING_KEY) } catch { /* storage unavailable */ }
}

let sending = false

// Sends the play along with any that failed to send earlier; anything that fails again waits for the next play.
export async function sendListeningEvent(event: ListeningEvent | null, fetcher: typeof fetch = fetch) {
  const session = useAuth.getState().session
  const events = [...readPending(), ...(event ? [event] : [])]
  if (!events.length) return
  if (!session || sending) { writePending(events); return }
  const batch = events.slice(0, 50)
  sending = true
  writePending(events.slice(batch.length))
  try {
    const response = await fetcher('/api/listening', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt },
      body: JSON.stringify({ events: batch }),
    })
    // A 400 means the server will never accept these, so they are dropped rather than retried forever.
    if (!response.ok && response.status !== 400) writePending([...batch, ...readPending()])
  } catch {
    writePending([...batch, ...readPending()])
  } finally {
    sending = false
  }
}
