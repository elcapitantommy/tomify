// Live playback: one row per account holds the device that owns playback (its queue, position and play state),
// the recent remote-control commands, and which of the account's devices are open right now (presence).
// Clients poll GET /api/live-playback; the owner publishes with POST; other devices send commands; a closing tab calls /leave.

import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

const LIVE_PLAYBACK_COMMANDS = ['play', 'pause', 'next', 'previous', 'seek', 'toggle-shuffle', 'cycle-repeat', 'play-index', 'remove-index', 'clear-queue', 'toggle-muted', 'set-volume', 'add-to-queue', 'transfer']
// A device counts as online if it polled within this window; presence rows are only rewritten this often to save D1 writes.
const LIVE_DEVICE_ONLINE_MS = 45000
const LIVE_PRESENCE_WRITE_MS = 15000
// Commands are kept as a short list so two quick presses (next, next) are both delivered.
const LIVE_COMMAND_HISTORY = 10

// The live_playback row as selectRow reads it.
interface LivePlaybackRow { deviceId: string | null; deviceName: string | null; stateJson: string; revision: number | null; updatedAt: number | null; commandJson: string | null; commandRevision: number | null; commandTargetDevice: string | null; commandUpdatedAt: number | null }
interface LiveCommand { action: string; revision: number; targetDeviceId?: unknown; updatedAt?: number; value?: number; track?: QueuedTrack }
interface LiveDevice { deviceId: string; deviceName: string; lastSeen: number }
type QueuedTrack = { id: string; title: string; artist: string; album: string } & Record<string, string | number>
// Request bodies come from clients, so every field is checked before use.
type Body = Record<string, unknown>


function cleanDeviceName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : 'Web'
}
// command_json used to hold a single command object; it now holds the most recent commands, newest last.
function parseLiveCommands(row: Pick<LivePlaybackRow, 'commandJson' | 'commandRevision' | 'commandTargetDevice' | 'commandUpdatedAt'> | null | undefined): LiveCommand[] {
  if (!row || !row.commandJson) return []
  try {
    const parsed = JSON.parse(row.commandJson)
    if (Array.isArray(parsed)) return parsed.filter((command: LiveCommand | null) => command && typeof command.action === 'string' && Number.isInteger(command.revision))
    if (parsed && typeof parsed.action === 'string' && row.commandTargetDevice) {
      return [{ ...parsed, revision: Number(row.commandRevision || 0), targetDeviceId: row.commandTargetDevice, updatedAt: Number(row.commandUpdatedAt || 0) }]
    }
  } catch { /* unreadable command history */ }
  return []
}

function cleanQueuedTrack(input: unknown): QueuedTrack | null {
  const value = input as Body | null
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null
  const track: QueuedTrack = { id: value.id, title: String(value.title || ''), artist: String(value.artist || ''), album: String(value.album || '') }
  for (const key of ['artistId', 'albumId', 'coverArt', 'suffix', 'contentType', 'musicBrainzId', 'isrc', 'starred']) { const text = value[key]; if (typeof text === 'string') track[key] = text }
  for (const key of ['duration', 'track', 'discNumber']) { const number = value[key]; if (typeof number === 'number' && Number.isFinite(number)) track[key] = number }
  return track
}

async function onlineLiveDevices(db: D1Database, username: string, now: number): Promise<LiveDevice[]> {
  const result = await db.prepare('SELECT device_id AS deviceId, device_name AS deviceName, last_seen AS lastSeen FROM live_playback_devices WHERE username = ? AND last_seen >= ? ORDER BY device_name').bind(username, now - LIVE_DEVICE_ONLINE_MS).all<{ deviceId: string; deviceName: string; lastSeen: number }>()
  return (result.results || []).map((device) => ({ deviceId: device.deviceId, deviceName: device.deviceName, lastSeen: Number(device.lastSeen) }))
}

async function touchLiveDevice(db: D1Database, username: string, deviceId: string, deviceName: string, now: number, devices: LiveDevice[]): Promise<LiveDevice[]> {
  const known = devices.find((device) => device.deviceId === deviceId)
  if (known && known.deviceName === deviceName && now - known.lastSeen < LIVE_PRESENCE_WRITE_MS) return devices
  await db.prepare('INSERT INTO live_playback_devices (username, device_id, device_name, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(username, device_id) DO UPDATE SET device_name = excluded.device_name, last_seen = excluded.last_seen')
    .bind(username, deviceId, deviceName, now).run()
  return [...devices.filter((device) => device.deviceId !== deviceId), { deviceId, deviceName, lastSeen: now }].sort((a, b) => a.deviceName.localeCompare(b.deviceName))
}

export async function handleLivePlaybackRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/live-playback')) return null
  if (!env || !env.TOMIFY_DB) return json({ error: 'live-playback-store-unavailable' }, 503)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  const db = env.TOMIFY_DB
  const selectRow = () => db.prepare('SELECT device_id AS deviceId, device_name AS deviceName, state_json AS stateJson, revision, updated_at AS updatedAt, command_json AS commandJson, command_revision AS commandRevision, command_target_device AS commandTargetDevice, command_updated_at AS commandUpdatedAt FROM live_playback WHERE username = ?').bind(username).first<LivePlaybackRow>()

  if (url.pathname === '/api/live-playback' && request.method === 'GET') {
    const now = Date.now()
    let devices = await onlineLiveDevices(db, username, now)
    const deviceId = url.searchParams.get('deviceId')
    if (deviceId) devices = await touchLiveDevice(db, username, deviceId.slice(0, 128), cleanDeviceName(url.searchParams.get('deviceName')), now, devices)
    const row = await selectRow()
    if (!row) return json({ state: null, command: null, commands: [], devices, now })

    let state = null
    try {
      state = { ...JSON.parse(row.stateJson), deviceId: row.deviceId, deviceName: row.deviceName, revision: Number(row.revision || 0), updatedAt: Number(row.updatedAt || 0) }
    } catch { state = null }
    const commands = parseLiveCommands(row)
    return json({ state, command: commands[commands.length - 1] || null, commands, devices, now })
  }

  if (url.pathname === '/api/live-playback' && request.method === 'POST') {
    const body = await request.json<Body>().catch(() => null)
    if (!body || typeof body.deviceId !== 'string' || !Array.isArray(body.queue) || !Number.isInteger(body.currentIndex)) return json({ error: 'invalid-live-playback-state' }, 400)

    const previous = await db.prepare('SELECT device_id AS deviceId, revision FROM live_playback WHERE username = ?').bind(username).first<{ deviceId: string | null; revision: number | null }>()
    const takeover = body.takeover === true
    if (previous && previous.deviceId && previous.deviceId !== body.deviceId && !takeover) {
      return json({ error: 'playback-owned-by-another-device', deviceId: previous.deviceId }, 409)
    }
    const revision = Number((previous && previous.revision) || 0) + 1
    const updatedAt = Date.now()
    const state = {
      queue: body.queue,
      currentIndex: body.currentIndex,
      playing: body.playing === true,
      currentTime: Number(body.currentTime || 0),
      duration: Number(body.duration || 0),
      volume: Math.max(0, Math.min(1, Number(body.volume ?? 0.8))),
      muted: body.muted === true,
      shuffle: body.shuffle === true,
      repeat: (['off', 'all', 'one'] as unknown[]).includes(body.repeat) ? body.repeat : 'off',
    }
    const deviceName = cleanDeviceName(body.deviceName)

    await db.batch([
      db.prepare('INSERT INTO live_playback (username, device_id, device_name, state_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET device_id = excluded.device_id, device_name = excluded.device_name, state_json = excluded.state_json, revision = excluded.revision, updated_at = excluded.updated_at')
        .bind(username, body.deviceId, deviceName, JSON.stringify(state), revision, updatedAt),
      db.prepare('INSERT INTO live_playback_devices (username, device_id, device_name, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(username, device_id) DO UPDATE SET device_name = excluded.device_name, last_seen = excluded.last_seen')
        .bind(username, body.deviceId, deviceName, updatedAt),
    ])

    return json({ state: { ...state, deviceId: body.deviceId, deviceName, revision, updatedAt } })
  }

  // A tab that is closing or reloading: it drops out of the device list and, if it owned playback, shows as paused at once.
  if (url.pathname === '/api/live-playback/leave' && request.method === 'POST') {
    const body = await request.json<Body>().catch(() => null)
    if (!body || typeof body.deviceId !== 'string') return json({ error: 'invalid-device' }, 400)
    await db.prepare('DELETE FROM live_playback_devices WHERE username = ? AND device_id = ?').bind(username, body.deviceId).run()
    const row = await selectRow()
    if (row && row.deviceId === body.deviceId) {
      let state: { playing?: boolean; currentTime?: number } | null = null
      try { state = JSON.parse(row.stateJson) } catch { state = null }
      if (state && state.playing) {
        state.playing = false
        if (typeof body.currentTime === 'number' && Number.isFinite(body.currentTime)) state.currentTime = Math.max(0, body.currentTime)
        await db.prepare('UPDATE live_playback SET state_json = ?, revision = ?, updated_at = ? WHERE username = ?')
          .bind(JSON.stringify(state), Number(row.revision || 0) + 1, Date.now(), username).run()
      }
    }
    return json({ ok: true })
  }

  if (url.pathname === '/api/live-playback/command' && request.method === 'POST') {
    const body = await request.json<Body>().catch(() => null)
    if (!body || typeof body.targetDeviceId !== 'string' || !(LIVE_PLAYBACK_COMMANDS as unknown[]).includes(body.action)) return json({ error: 'invalid-command' }, 400)

    const row = await selectRow()
    if (!row) return json({ error: 'no-active-playback' }, 404)
    const now = Date.now()
    if (body.action === 'transfer') {
      // Any open device can be asked to take over; it picks up the queue and position from the shared state.
      if (body.targetDeviceId === row.deviceId) return json({ error: 'already-playing-there' }, 409)
      const devices = await onlineLiveDevices(db, username, now)
      if (!devices.some((device) => device.deviceId === body.targetDeviceId)) return json({ error: 'device-offline' }, 409)
    } else if (row.deviceId !== body.targetDeviceId) {
      return json({ error: 'playback-device-changed' }, 409)
    }

    const commands = parseLiveCommands(row)
    const revision = Math.max(Number(row.commandRevision || 0), ...commands.map((item) => item.revision)) + 1
    const command: LiveCommand = { action: body.action as string, revision, targetDeviceId: body.targetDeviceId, updatedAt: now }
    if (typeof body.value === 'number' && Number.isFinite(body.value)) command.value = body.value
    if (body.action === 'add-to-queue') {
      const track = cleanQueuedTrack(body.track)
      if (!track) return json({ error: 'invalid-command' }, 400)
      command.track = track
    }
    const history = [...commands, command].slice(-LIVE_COMMAND_HISTORY)

    await db.prepare('UPDATE live_playback SET command_json = ?, command_revision = ?, command_target_device = ?, command_updated_at = ? WHERE username = ?')
      .bind(JSON.stringify(history), revision, body.targetDeviceId, now, username).run()

    return json({ command })
  }

  return null
}

export {
  LIVE_COMMAND_HISTORY,
  LIVE_DEVICE_ONLINE_MS,
  LIVE_PLAYBACK_COMMANDS,
  LIVE_PRESENCE_WRITE_MS,
  cleanQueuedTrack,
  parseLiveCommands,
}
