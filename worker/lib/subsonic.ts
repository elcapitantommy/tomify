import type { Env } from '../env.ts'
import { navidromeUrl } from './navidrome.ts'

export type SubsonicParams = Record<string, string | number | undefined>
export type SubsonicCall = <T = Record<string, unknown>>(endpoint: string, params?: SubsonicParams) => Promise<T>

// Calls Navidrome's Subsonic API as the signed-in user, with the token and salt their request carried.
export function subsonicForRequest(request: Request, username: string, env: Env, fetcher: typeof fetch = fetch): SubsonicCall {
  const token = request.headers.get('x-tomify-token') || ''
  const salt = request.headers.get('x-tomify-salt') || ''
  return async <T>(endpoint: string, params: SubsonicParams = {}) => {
    const url = navidromeUrl(env, `/rest/${endpoint}.view`)
    const query: SubsonicParams = { u: username, t: token, s: salt, v: '1.16.1', c: 'Tomify', f: 'json', ...params }
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await fetcher(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Navidrome ${endpoint} returned ${response.status}.`)
    const body = await response.json() as { 'subsonic-response'?: { status?: string, error?: { message?: string } } & Record<string, unknown> }
    const data = body?.['subsonic-response']
    if (!data || data.status !== 'ok') throw new Error(data?.error?.message || `Navidrome ${endpoint} failed.`)
    return data as T
  }
}
