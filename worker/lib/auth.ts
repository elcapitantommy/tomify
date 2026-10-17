import type { Env } from '../env.ts'
import { navidromeUrl } from './navidrome.ts'

const authCache = new Map<string, number>()

export async function authenticate(request: Request, env: Env): Promise<string | null> {
  return authenticateCredentials(env, request.headers.get('x-tomify-user'), request.headers.get('x-tomify-token'), request.headers.get('x-tomify-salt'))
}

// Media elements can't send headers, so streaming URLs carry the Subsonic login in the query instead.
export async function authenticateCredentials(env: Env, username: string | null, token: string | null, salt: string | null): Promise<string | null> {
  if (!username || !token || !salt) return null
  const ping = navidromeUrl(env, '/rest/ping.view')
  const cacheKey = ping.origin + ':' + username + ':' + token + ':' + salt
  const cachedAt = authCache.get(cacheKey)
  if (cachedAt && Date.now() - cachedAt < 30000) return username
  try {
    ping.searchParams.set('u', username)
    ping.searchParams.set('t', token)
    ping.searchParams.set('s', salt)
    ping.searchParams.set('v', '1.16.1')
    ping.searchParams.set('c', 'Tomify')
    ping.searchParams.set('f', 'json')
    const response = await fetch(ping, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const body = await response.json() as { 'subsonic-response'?: { status?: string } }
    if (body?.['subsonic-response']?.status === 'ok') {
      authCache.set(cacheKey, Date.now())
      return username
    }
    return null
  } catch {
    return null
  }
}

export async function isNavidromeAdmin(request: Request, username: string, env: Env): Promise<boolean> {
  const lookup = navidromeUrl(env, '/rest/getUser.view')
  try {
    lookup.searchParams.set('u', username)
    lookup.searchParams.set('t', request.headers.get('x-tomify-token') || '')
    lookup.searchParams.set('s', request.headers.get('x-tomify-salt') || '')
    lookup.searchParams.set('v', '1.16.1')
    lookup.searchParams.set('c', 'Tomify')
    lookup.searchParams.set('f', 'json')
    lookup.searchParams.set('username', username)
    const response = await fetch(lookup, { headers: { accept: 'application/json' } })
    if (!response.ok) return false
    const body = await response.json() as { 'subsonic-response'?: { status?: string, user?: { adminRole?: boolean } } }
    const subsonic = body?.['subsonic-response']
    return Boolean(subsonic?.status === 'ok' && subsonic.user?.adminRole === true)
  } catch {
    return false
  }
}
