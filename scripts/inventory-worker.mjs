// Admin-only pass-through for the recovery agent's read-only library inventory. There is deliberately no UI yet.
// An older agent answers 404; expose that as unavailable rather than an agent or contract failure.
async function handleInventoryRequest(request, env, url) {
  const match = url.pathname.match(/^\/api\/inventory\/(scan|status|summary)$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can inspect the library inventory.' }, 403)
  try {
    const result = await callRecoveryAgent(env, `/v1/inventory/${match[1]}`, {})
    return json(result, match[1] === 'scan' && result?.started ? 202 : 200)
  } catch (error) {
    if (error instanceof RecoveryAgentOutdated) return json({ error: 'inventory-not-available', message: 'Library inventory is not available on this recovery agent.' }, 404)
    return json({ error: 'inventory-failed', message: error instanceof Error ? error.message : 'The library inventory request failed.' }, 502)
  }
}

export const inventoryWorkerSource = handleInventoryRequest.toString()
