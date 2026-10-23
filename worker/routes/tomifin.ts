import type { Env, RouteHandler } from '../env.ts'
import { callRecoveryAgent, RecoveryAgentError, RecoveryAgentOutdated } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

// Tomifin Downloader's API: films and TV searched through Recovery's torrent sources and queued in the same
// qBittorrent, saved into the Family or Private Jellyfin library. The recovery agent does the work
// (recovery-agent/tomifin.mjs) and checks the Jellyfin sign-in (recovery-agent/jellyfin.mjs); this route keeps the
// Jellyfin session in an HttpOnly cookie, validates every input and passes only those fields on. The browser never
// sees a torrent link, a path or a credential other than its own session cookie.

const DESTINATIONS = new Set(['family', 'private'])
const KINDS = new Set(['video', 'movies', 'tv'])
const RESULT_ID = /^[a-f0-9]{64}$/
const JOB_ROUTE = /^\/api\/tomifin\/downloads\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(pause|resume|cancel)$/
const COOKIE = 'tomifin_session'
const COOKIE_DAYS = 30
const STATUS_FOR_CODE: Record<string, number> = { unauthorized: 401, 'invalid-login': 401, forbidden: 403, duplicate: 409, 'result-expired': 409, unconfirmed: 504, 'not-configured': 503, 'jellyfin-unavailable': 502 }

function invalid(error: string, message: string) { return json({ error, message }, 400) }

function sessionCookie(request: Request): string | null {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE) return decodeURIComponent(value.join('=')) || null
  }
  return null
}

function withCookie(response: Response, value: string | null) {
  const cookie = value
    ? `${COOKIE}=${encodeURIComponent(value)}; Path=/api/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`
    : `${COOKIE}=; Path=/api/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  response.headers.append('set-cookie', cookie)
  return response
}

async function agent(env: Env, path: string, body: unknown, status = 200): Promise<Response> {
  try {
    return json(await callRecoveryAgent(env, path, body), status)
  } catch (error) {
    if (error instanceof RecoveryAgentOutdated) return json({ error: 'recovery-agent-outdated', message: 'The media server needs the latest recovery agent for Tomifin Downloader. ' + error.message }, 409)
    if (error instanceof RecoveryAgentError && error.payload?.error === 'tomifin-error') {
      const code = String(error.payload.code || 'tomifin-error')
      const response = json({ error: code, message: error.message }, STATUS_FOR_CODE[code] || 400)
      // A session Jellyfin no longer accepts is dropped, so the page shows the sign-in form.
      return code === 'unauthorized' || code === 'forbidden' ? withCookie(response, null) : response
    }
    // The agent answered but could not do it (qBittorrent refused, the VPN is down, …): its message says why.
    if (error instanceof RecoveryAgentError) return json({ error: 'agent-error', message: error.message }, 502)
    return json({ error: 'agent-unavailable', message: error instanceof Error ? error.message : 'The media server could not be reached.' }, 502)
  }
}

export const tomifinRoute: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/api/tomifin' && !url.pathname.startsWith('/api/tomifin/')) return null
  if (!env.RECOVERY_AGENT_URL) return json({ error: 'not-configured', message: 'The recovery agent is not configured.' }, 503)
  // Changes must come from Tomifin's own page: a cross-site form cannot set this header, and the cookie is SameSite.
  if (request.method !== 'GET' && request.headers.get('x-tomifin') !== '1') return json({ error: 'forbidden', message: 'Missing request header.' }, 403)

  if (url.pathname === '/api/tomifin/session') {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null) as { username?: unknown, password?: unknown } | null
      const username = typeof body?.username === 'string' ? body.username.trim() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!username || username.length > 128) return invalid('invalid-login', 'Enter your Jellyfin username.')
      if (password.length > 512) return invalid('invalid-login', 'That password is too long.')
      const response = await agent(env, '/v1/tomifin/login', { username, password })
      if (!response.ok) return response
      const { token, user } = await response.json() as { token: string, user: { name: string } }
      console.log(`Tomifin: ${user.name} signed in`)
      return withCookie(json({ user }), token)
    }
    const session = sessionCookie(request)
    if (request.method === 'DELETE') {
      if (session) await agent(env, '/v1/tomifin/logout', { session })
      return withCookie(json({ signedOut: true }), null)
    }
    if (request.method === 'GET') return session ? agent(env, '/v1/tomifin/session', { session }) : json({ error: 'unauthorized', message: 'Sign in with your Jellyfin account.' }, 401)
    return json({ error: 'not-found' }, 404)
  }

  const session = sessionCookie(request)
  if (!session) return json({ error: 'unauthorized', message: 'Sign in with your Jellyfin account.' }, 401)

  if (url.pathname === '/api/tomifin/status' && request.method === 'GET') return agent(env, '/v1/tomifin/status', { session })

  if (url.pathname === '/api/tomifin/search' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim()
    const kind = url.searchParams.get('kind') || 'video'
    if (query.length < 2) return invalid('invalid-query', 'Type at least two characters to search.')
    if (query.length > 200) return invalid('invalid-query', 'The search is too long (200 characters at most).')
    if (!KINDS.has(kind)) return invalid('invalid-kind', 'Choose films, TV or both.')
    return agent(env, '/v1/tomifin/search', { session, query, kind })
  }

  if (url.pathname === '/api/tomifin/download' && request.method === 'POST') {
    const body = await request.json().catch(() => null) as { resultId?: unknown, destination?: unknown } | null
    const destination = typeof body?.destination === 'string' ? body.destination : ''
    const resultId = typeof body?.resultId === 'string' ? body.resultId : ''
    if (!DESTINATIONS.has(destination)) return invalid('invalid-destination', 'Choose Family or Private before downloading.')
    if (!RESULT_ID.test(resultId)) return invalid('invalid-result', 'Choose a search result to download.')
    const response = await agent(env, '/v1/tomifin/download', { session, resultId, destination }, 202)
    if (response.ok) console.log(`Tomifin: queued a download for ${destination}`)
    return response
  }

  if (url.pathname === '/api/tomifin/downloads' && request.method === 'GET') return agent(env, '/v1/tomifin/downloads', { session })

  const job = url.pathname.match(JOB_ROUTE)
  if (job && request.method === 'POST') {
    const response = await agent(env, `/v1/tomifin/${job[2]}`, { session, id: job[1] })
    if (response.ok && job[2] === 'cancel') console.log(`Tomifin: cancelled download ${job[1]}`)
    return response
  }

  return json({ error: 'not-found' }, 404)
}
