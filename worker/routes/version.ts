import type { RouteHandler } from '../env.ts'
import { json } from '../lib/http.ts'
import { TOMIFY_AGENT_CONTRACT, TOMIFY_VERSION } from '../generated/build-info.ts'

export const versionRoute: RouteHandler = async (request, _env, url) => {
  if (url.pathname !== '/api/version' || request.method !== 'GET') return null
  return json({ version: TOMIFY_VERSION, contract: TOMIFY_AGENT_CONTRACT })
}
