import { useAuth } from '../stores/auth'
import type { Track } from '../types'

export interface Mix { id: string; title: string; description: string; kind: string; tracks: Track[]; coverArt: string[] }
export interface MixesResponse { mixes: Mix[]; generatedAt: number | null; curatedBy: string | null; refreshing: boolean; stale: boolean; aiEnabled: boolean; lastError: string | null; message?: string }

function authHeaders(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to see your mixes.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<MixesResponse> {
  const response = await fetch(path, { ...init, signal, headers: { ...authHeaders(), ...init.headers } })
  const body = await response.json().catch(() => ({})) as MixesResponse & { error?: string }
  if (!response.ok && response.status !== 202) throw new Error(body.message || body.error || 'Tomify could not load your mixes.')
  return body
}

let cached: MixesResponse | null = null
export const cachedMixes = () => cached
const remember = (value: MixesResponse) => { if (Array.isArray(value.mixes)) cached = value; return value }

export const mixesApi = {
  load: async (signal?: AbortSignal) => remember(await request('/api/mixes', {}, signal)),
  // Builds new mixes if the current ones are stale (or, with force, older than a few minutes). Can take a while.
  refresh: async (force = false) => remember(await request('/api/mixes/refresh', { method: 'POST', body: JSON.stringify({ force }) })),
}
