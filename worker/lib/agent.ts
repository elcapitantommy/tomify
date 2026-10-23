/* Agent responses are backend-specific JSON payloads validated by their route handlers. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Env } from '../env.ts'

export async function callRecoveryAgent(env: Env, path: string, body: unknown): Promise<any> {
  if (!env.RECOVERY_AGENT_URL) throw new Error('The recovery agent is not configured.')
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (env.RECOVERY_AGENT_TOKEN) headers.authorization = 'Bearer ' + env.RECOVERY_AGENT_TOKEN
  const baseUrl = String(env.RECOVERY_AGENT_URL)
  const response = await fetch((baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as any
  if (response.status === 404 && payload.error === 'not-found') throw new RecoveryAgentOutdated()
  if (!response.ok) throw new RecoveryAgentError(payload.message || payload.error || 'Recovery agent request failed.', response.status, payload)
  return payload
}

const recoveryAgentStatusCache = new Map<string, { checkedAt: number, value: any }>()

export async function recoveryAgentStatus(env: Env): Promise<any> {
  const cacheKey = String(env.RECOVERY_AGENT_URL || '') + ':' + String(env.RECOVERY_AGENT_TOKEN || '')
  const cached = recoveryAgentStatusCache.get(cacheKey)
  if (cached && Date.now() - cached.checkedAt < 60000) return cached.value
  const value = await callRecoveryAgent(env, '/v1/status', {})
  recoveryAgentStatusCache.set(cacheKey, { checkedAt: Date.now(), value })
  return value
}

export class RecoveryAgentOutdated extends Error {
  constructor() {
    super('The recovery agent is out of date. Redeploy it using docs/RECOVERY.md, “Updating the recovery agent”: https://github.com/elcapitantommy/tomify/blob/main/docs/RECOVERY.md#updating-the-recovery-agent')
    this.name = 'RecoveryAgentOutdated'
  }
}

// A refusal from the agent, with its status and JSON body for routes that pass the agent's own error code on.
export class RecoveryAgentError extends Error {
  status: number
  payload: any
  constructor(message: string, status: number, payload: any) {
    super(message)
    this.name = 'RecoveryAgentError'
    this.status = status
    this.payload = payload
  }
}
