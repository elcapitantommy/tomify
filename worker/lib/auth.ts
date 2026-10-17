const authCache = new Map<string, number>()

export async function authenticate(request: Request): Promise<string | null> {
  const username = request.headers.get('x-tomify-user')
  const token = request.headers.get('x-tomify-token')
  const salt = request.headers.get('x-tomify-salt')
  if (!username || !token || !salt) return null
  const cacheKey = username + ':' + token + ':' + salt
  const cachedAt = authCache.get(cacheKey)
  if (cachedAt && Date.now() - cachedAt < 30000) return username
  try {
    const ping = new URL('https://tomify.tomdixon.uk/rest/ping.view')
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

export async function isNavidromeAdmin(request: Request, username: string): Promise<boolean> {
  try {
    const lookup = new URL('https://tomify.tomdixon.uk/rest/getUser.view')
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
