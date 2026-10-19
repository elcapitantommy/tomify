import { useAuth } from '../stores/auth'

export interface StatsRow { plays: number; seconds: number; artist?: string | null; artistId?: string | null; album?: string | null; albumId?: string | null; title?: string | null; trackId?: string }
export interface ListeningSummary { days: number; plays: number; skips: number; seconds: number; artists: StatsRow[]; albums: StatsRow[]; tracks: StatsRow[] }

export const listeningStatsApi = {
  async load(days: number): Promise<ListeningSummary> {
    const session = useAuth.getState().session
    if (!session) throw new Error('Sign in to see your listening stats.')
    const response = await fetch(`/api/listening/stats?days=${days}`, { headers: { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt } })
    const body = await response.json().catch(() => ({})) as ListeningSummary & { error?: string; message?: string }
    if (!response.ok) throw new Error(body.message || body.error || 'Listening stats are unavailable.')
    return body
  },
}
