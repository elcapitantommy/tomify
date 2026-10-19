import type { RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { mediaToken } from '../features/media-session.ts'

// POST /api/media-session (x-tomify-* login): a media token for stream URLs, and where the box
// answers on the home network. 404 until TOMIFY_MEDIA_KEY is set, so the player keeps the old URLs.
export const mediaSessionRoute: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/api/media-session') return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  if (!env.TOMIFY_MEDIA_KEY) return json({ error: 'not-configured' }, 404)
  const user = await authenticate(request, env)
  if (!user) return json({ error: 'unauthorized' }, 401)
  const headers = request.headers
  return json({ ...await mediaToken(env, [user, headers.get('x-tomify-token')!, headers.get('x-tomify-salt')!]), lanOrigin: env.TOMIFY_LAN_ORIGIN || null })
}
