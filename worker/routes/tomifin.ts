import type { Env, RouteHandler } from '../env.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent, RecoveryAgentError, RecoveryAgentOutdated } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

// Tomifin Downloader (/tomifin/): films and TV searched through Recovery's torrent sources and queued in the same
// qBittorrent, saved into the Family or Private Jellyfin library. The recovery agent does the work
// (recovery-agent/tomifin.mjs); this route checks the caller is a Navidrome administrator, validates every input
// and passes only those fields on. The browser never sees a torrent link, a path or a credential.

const DESTINATIONS = new Set(['family', 'private'])
const KINDS = new Set(['video', 'movies', 'tv'])
const RESULT_ID = /^[a-f0-9]{64}$/
const JOB_ROUTE = /^\/api\/tomifin\/downloads\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(pause|resume|cancel)$/

function invalid(error: string, message: string) { return json({ error, message }, 400) }

async function agent(env: Env, path: string, body: unknown, status = 200): Promise<Response> {
  try {
    return json(await callRecoveryAgent(env, path, body), status)
  } catch (error) {
    if (error instanceof RecoveryAgentOutdated) return json({ error: 'recovery-agent-outdated', message: 'The media server needs the latest recovery agent for Tomifin Downloader. ' + error.message }, 409)
    if (error instanceof RecoveryAgentError && error.payload?.error === 'tomifin-error') {
      const code = String(error.payload.code || 'tomifin-error')
      const conflict = code === 'duplicate' || code === 'result-expired'
      const unavailable = code === 'not-configured'
      return json({ error: code, message: error.message }, unavailable ? 503 : conflict ? 409 : 400)
    }
    // The agent answered but could not do it (qBittorrent refused, the VPN is down, …): its message says why.
    if (error instanceof RecoveryAgentError) return json({ error: 'agent-error', message: error.message }, 502)
    return json({ error: 'agent-unavailable', message: error instanceof Error ? error.message : 'The media server could not be reached.' }, 502)
  }
}

export const tomifinRoute: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/api/tomifin' && !url.pathname.startsWith('/api/tomifin/')) return null
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized', message: 'Sign in to Tomify first.' }, 401)
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can use Tomifin Downloader.' }, 403)

  if (url.pathname === '/api/tomifin/status' && request.method === 'GET') {
    if (!env.RECOVERY_AGENT_URL) return json({ available: false, problem: 'The recovery agent is not configured.', destinations: [{ id: 'family', label: 'Family', available: false }, { id: 'private', label: 'Private', available: false }] })
    return agent(env, '/v1/tomifin/status', {})
  }

  if (url.pathname === '/api/tomifin/search' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim()
    const kind = url.searchParams.get('kind') || 'video'
    if (query.length < 2) return invalid('invalid-query', 'Type at least two characters to search.')
    if (query.length > 200) return invalid('invalid-query', 'The search is too long (200 characters at most).')
    if (!KINDS.has(kind)) return invalid('invalid-kind', 'Choose films, TV or both.')
    return agent(env, '/v1/tomifin/search', { query, kind })
  }

  if (url.pathname === '/api/tomifin/download' && request.method === 'POST') {
    const body = await request.json().catch(() => null) as { resultId?: unknown, destination?: unknown } | null
    const destination = typeof body?.destination === 'string' ? body.destination : ''
    const resultId = typeof body?.resultId === 'string' ? body.resultId : ''
    if (!DESTINATIONS.has(destination)) return invalid('invalid-destination', 'Choose Family or Private before downloading.')
    if (!RESULT_ID.test(resultId)) return invalid('invalid-result', 'Choose a search result to download.')
    const response = await agent(env, '/v1/tomifin/download', { resultId, destination }, 202)
    if (response.ok) console.log(`Tomifin: ${username} queued a download for ${destination}`)
    return response
  }

  if (url.pathname === '/api/tomifin/downloads' && request.method === 'GET') return agent(env, '/v1/tomifin/downloads', {})

  const job = url.pathname.match(JOB_ROUTE)
  if (job && request.method === 'POST') {
    const response = await agent(env, `/v1/tomifin/${job[2]}`, { id: job[1] })
    if (response.ok && job[2] === 'cancel') console.log(`Tomifin: ${username} cancelled download ${job[1]}`)
    return response
  }

  return json({ error: 'not-found' }, 404)
}
