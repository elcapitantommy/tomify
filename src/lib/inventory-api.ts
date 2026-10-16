import { useAuth } from '../stores/auth'

export type InventoryEntry = { kind: string; label: string; paths: string[]; missingPath?: string | null; albumId?: string | null; recoveryId?: string | null; expectedTracks?: number | null; actualTracks?: number | null }
export type InventoryCategory = 'duplicates' | 'partialAlbums' | 'orphanedSources' | 'shadowedRecovery' | 'missingD1Files'
export type DismissedInventoryEntry = InventoryEntry & { category: InventoryCategory; dismissedBy?: string | null; dismissedAt?: string | null }
export type InventoryReport = { completedAt: string | null; duplicates: InventoryEntry[]; partialAlbums: InventoryEntry[]; orphanedSources: InventoryEntry[]; shadowedRecovery: InventoryEntry[]; missingD1Files: InventoryEntry[]; dismissed?: DismissedInventoryEntry[] }
export type InventoryStatus = { state: 'idle' | 'running' | 'completed' | 'failed'; progress: number; filesDiscovered: number; filesProcessed: number; currentPath: string | null; lastCompletedAt: string | null; error: string | null }

export class InventoryUnavailableError extends Error {}

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to inspect library health.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}

async function request<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (response.status === 404 && result.error === 'inventory-not-available') throw new InventoryUnavailableError(result.message || 'Library inventory is unavailable.')
  if (!response.ok) throw new Error(result.message || result.error || 'The library inventory request failed.')
  return result
}

export async function loadInventoryReport() { return (await request<{ report: InventoryReport }>('/api/inventory/report')).report }
export async function loadInventoryStatus() { return (await request<{ status: InventoryStatus }>('/api/inventory/status')).status }
export async function startInventoryScan() { return request<{ started: boolean; status: InventoryStatus }>('/api/inventory/scan') }

// Marks a finding as fine (or, with restore, reports it again). Stored in D1, so it applies to every administrator.
export async function setInventoryDismissal(category: InventoryCategory, entry: InventoryEntry, restore = false) {
  await request<{ ok: boolean }>('/api/inventory/dismiss', { category, paths: entry.paths, label: entry.label, restore })
}
