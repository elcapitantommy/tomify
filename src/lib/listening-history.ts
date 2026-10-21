import { useAuth } from '../stores/auth'
import type { Track } from '../types'

export interface HistoryEvent {
  id: number; trackId: string; albumId: string | null; artistId: string | null
  title: string | null; artist: string | null; album: string | null
  durationSeconds: number | null; listenedSeconds: number; completed: boolean; skipped: boolean
  playedAt: number; device: string | null
}
export interface HistoryPage { events: HistoryEvent[]; next: string | null }

export async function loadHistory(before?: string | null): Promise<HistoryPage> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to see your listening history.')
  const response = await fetch(`/api/listening/history${before ? `?before=${encodeURIComponent(before)}` : ''}`, { headers: { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt } })
  const body = await response.json().catch(() => ({})) as HistoryPage & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || body.error || 'Listening history is unavailable.')
  return body
}

// Enough of a song to play it again: Navidrome streams by id, and the rest fills in the player.
export function historyTrack(event: HistoryEvent): Track {
  return { id: event.trackId, title: event.title ?? 'Unknown song', artist: event.artist ?? '', artistId: event.artistId ?? undefined, album: event.album ?? '', albumId: event.albumId ?? undefined, coverArt: event.albumId ?? undefined, duration: event.durationSeconds ?? undefined }
}

// Playing a song from history carries on with what you played after it, as you heard it then.
export function replayFrom(events: HistoryEvent[], index: number, limit = 200): Track[] {
  return events.slice(Math.max(0, index - limit + 1), index + 1).reverse().map(historyTrack)
}

const dayKey = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` }

export function dayLabel(time: number, now = new Date()) {
  const key = dayKey(time)
  if (key === dayKey(now.getTime())) return 'Today'
  if (key === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime())) return 'Yesterday'
  const date = new Date(time)
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

export interface HistoryDay { label: string; plays: Array<{ event: HistoryEvent; index: number }> }

// Plays grouped by local day, newest first. `index` is the play's place in the whole list, for replayFrom.
export function groupByDay(events: HistoryEvent[], now = new Date(), hideSkipped = false): HistoryDay[] {
  const days: HistoryDay[] = []
  events.forEach((event, index) => {
    if (hideSkipped && event.skipped) return
    const label = dayLabel(event.playedAt, now)
    const last = days[days.length - 1]
    if (last?.label === label) last.plays.push({ event, index })
    else days.push({ label, plays: [{ event, index }] })
  })
  return days
}

export const playTime = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
