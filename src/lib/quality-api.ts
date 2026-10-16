import type { QualityTarget } from '../../shared/quality.mjs'
import { useAuth } from '../stores/auth'

export type QualityTargetOption = { id: QualityTarget; label: string; description: string }
export type QualitySettings = { target: QualityTarget; targets: QualityTargetOption[] }
export type QualityRecheck = { target: QualityTarget; checked: number; changed: number; recovered: number; needsUpgrade: number }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to change quality settings.')
  const headers = { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, ...(init.body ? { 'content-type': 'application/json' } : {}) }
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || body.error || 'Quality settings are unavailable.')
  return body
}

export const qualityApi = {
  get: () => request<QualitySettings>('/api/settings/quality'),
  setTarget: (target: QualityTarget) => request<QualitySettings>('/api/settings/quality', { method: 'PUT', body: JSON.stringify({ target }) }),
  recheck: () => request<QualityRecheck>('/api/settings/quality/recheck', { method: 'POST' }),
}
