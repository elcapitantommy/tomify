import { useAuth } from '../stores/auth'

export type InventoryEntry = { kind: string; label: string; paths: string[]; missingPath?: string | null; albumId?: string | null; recoveryId?: string | null; expectedTracks?: number | null; actualTracks?: number | null }
export type InventoryReport = { completedAt: string | null; duplicates: InventoryEntry[]; partialAlbums: InventoryEntry[]; orphanedSources: InventoryEntry[]; shadowedRecovery: InventoryEntry[]; missingD1Files: InventoryEntry[] }
export type InventoryStatus = { state: 'idle' | 'running' | 'completed' | 'failed'; progress: number; filesDiscovered: number; filesProcessed: number; currentPath: string | null; lastCompletedAt: string | null; error: string | null }

export class InventoryUnavailableError extends Error {}

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to inspect library health.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: headers(), body: '{}' })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (response.status === 404 && body.error === 'inventory-not-available') throw new InventoryUnavailableError(body.message || 'Library inventory is unavailable.')
  if (!response.ok) throw new Error(body.message || body.error || 'The library inventory request failed.')
  return body
}

export async function loadInventoryReport() { return (await request<{ report: InventoryReport }>('/api/inventory/report')).report }
export async function loadInventoryStatus() { return (await request<{ status: InventoryStatus }>('/api/inventory/status')).status }
export async function startInventoryScan() { return request<{ started: boolean; status: InventoryStatus }>('/api/inventory/scan') }
