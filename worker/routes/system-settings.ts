import type { RouteHandler } from '../env.ts'
import { handleLibraryScanRequest } from '../features/library-scan.ts'
import { handlePreflightRequest } from '../features/preflight.ts'
import { handleQualityRequest } from '../features/quality.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent, recoveryAgentStatus } from '../lib/agent.ts'
import { json } from '../lib/http.ts'

export const systemSettingsRoute: RouteHandler = async (request, env, url) => {
  const quality = await handleQualityRequest(request, env, url)
  if (quality) return quality
  const scan = await handleLibraryScanRequest(request, env, url)
  if (scan) return scan
  const preflight = await handlePreflightRequest(request, env, url)
  if (preflight) return preflight

  if (url.pathname === '/api/recovery-agent/status' && request.method === 'GET') {
    const username = await authenticate(request)
    if (!username) return json({ error: 'unauthorized' }, 401)
    if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can inspect the recovery agent.' }, 403)
    try {
      const status = await recoveryAgentStatus(env)
      return json({ version: status?.version ?? null, contract: Number.isInteger(status?.contract) ? status.contract : null })
    } catch (error) {
      return json({ error: 'recovery-agent-status-failed', message: error instanceof Error ? error.message : 'The recovery agent status is unavailable.' }, 502)
    }
  }

  if (url.pathname === '/api/system/reboot' && request.method === 'POST') {
    const username = await authenticate(request)
    if (!username) return json({ error: 'unauthorized' }, 401)
    if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can restart the media server.' }, 403)
    const body = await request.json().catch(() => ({})) as { confirm?: string }
    if (!body || body.confirm !== 'reboot') return json({ error: 'confirmation-required', message: 'Confirm the restart first.' }, 400)
    try {
      return json(await callRecoveryAgent(env, '/v1/system/reboot', { confirm: 'reboot' }), 202)
    } catch (error) {
      return json({ error: 'reboot-failed', message: error instanceof Error ? error.message : 'The media server could not be restarted.' }, 502)
    }
  }

  if (url.pathname === '/api/system/vpn' && (request.method === 'GET' || request.method === 'POST')) {
    const username = await authenticate(request)
    if (!username) return json({ error: 'unauthorized' }, 401)
    if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can manage the VPN.' }, 403)
    try {
      if (request.method === 'GET') return json(await callRecoveryAgent(env, '/v1/system/vpn/status', {}))
      const body = await request.json().catch(() => ({})) as { action?: string }
      const action = body && body.action
      if (action !== 'connect' && action !== 'disconnect') return json({ error: 'invalid-action', message: 'Choose connect or disconnect.' }, 400)
      return json(await callRecoveryAgent(env, '/v1/system/vpn', { action }))
    } catch (error) {
      return json({ error: 'vpn-failed', message: error instanceof Error ? error.message : 'The VPN could not be changed.' }, 502)
    }
  }
  return null
}
