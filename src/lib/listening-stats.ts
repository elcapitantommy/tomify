import { useAuth } from '../stores/auth'

export interface StatsRow { plays: number; seconds: number; artist?: string | null; artistId?: string | null; album?: string | null; albumId?: string | null; title?: string | null; trackId?: string; genre?: string | null }
export interface ListeningSummary { days: number | null; from: number; to: number; plays: number; skips: number; seconds: number; artists: StatsRow[]; albums: StatsRow[]; tracks: StatsRow[]; genres: StatsRow[]; years: number[] }
export interface WrappedTrack { trackId: string; title: string | null; artist: string | null; albumId: string | null; playedAt?: number; day?: string; plays?: number }
export interface Wrapped {
  year: number; plays: number; skips: number; seconds: number
  artists: StatsRow[]; albums: StatsRow[]; tracks: StatsRow[]; genres: StatsRow[]
  months: { month: number; plays: number; seconds: number }[]
  firstTrack: WrappedTrack | null; mostRepeated: WrappedTrack | null
  newArtistCount: number; newArtists: StatsRow[]; playlist: string[]
  previous: { year: number; plays: number; seconds: number } | null
}

export const listenedFor = (seconds: number) => seconds >= 3600 ? `${(seconds / 3600).toFixed(seconds >= 36000 ? 0 : 1)} hours` : `${Math.round(seconds / 60)} minutes`

// The listening periods the stats page offers: rolling windows, or calendar periods in local time.
export type StatsPeriod = { days: number } | { from: number; to: number }
export function calendarPeriod(kind: 'week' | 'month' | 'year', now = new Date()): StatsPeriod {
  const start = kind === 'year' ? new Date(now.getFullYear(), 0, 1) : kind === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
  const end = kind === 'year' ? new Date(start.getFullYear() + 1, 0, 1) : kind === 'month' ? new Date(start.getFullYear(), start.getMonth() + 1, 1) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
  return { from: start.getTime(), to: end.getTime() }
}
// "2026-03" from a month input.
export function monthPeriod(value: string): StatsPeriod | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1]), month = Number(match[2]) - 1
  return { from: new Date(year, month, 1).getTime(), to: new Date(year, month + 1, 1).getTime() }
}

// Wrapped is offered on Home through December and January (for the year just ending or just ended).
export function wrappedSeasonYear(now = new Date()) {
  return now.getMonth() === 11 ? now.getFullYear() : now.getMonth() === 0 ? now.getFullYear() - 1 : null
}

async function get<T>(path: string): Promise<T> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to see your listening stats.')
  const response = await fetch(path, { headers: { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt } })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || body.error || 'Listening stats are unavailable.')
  return body
}

export const listeningStatsApi = {
  load(period: StatsPeriod | number): Promise<ListeningSummary> {
    const value = typeof period === 'number' ? { days: period } : period
    return get('days' in value ? `/api/listening/stats?days=${value.days}` : `/api/listening/stats?from=${value.from}&to=${value.to}`)
  },
  wrapped(year: number): Promise<Wrapped> { return get(`/api/listening/wrapped?year=${year}`) },
}
