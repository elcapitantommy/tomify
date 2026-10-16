import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { RepeatMode, Track } from '../types'
import { useAuth } from './auth'

export interface LivePlaybackSnapshot {
  deviceId: string
  deviceName: string
  queue: Track[]
  currentIndex: number
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  updatedAt: number
  revision: number
}

export type LivePlaybackCommandAction =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'seek'
  | 'toggle-shuffle'
  | 'cycle-repeat'
  | 'play-index'
  | 'remove-index'
  | 'clear-queue'
  | 'toggle-muted'
  | 'set-volume'
  | 'add-to-queue'
  | 'transfer'

export interface LivePlaybackCommand {
  revision: number
  targetDeviceId: string
  action: LivePlaybackCommandAction
  value?: number
  track?: Track
  updatedAt: number
}

export interface LivePlaybackDevice {
  deviceId: string
  deviceName: string
  lastSeen: number
}

export interface LivePlaybackResponse {
  state: LivePlaybackSnapshot | null
  command: LivePlaybackCommand | null
  commands?: LivePlaybackCommand[]
  devices?: LivePlaybackDevice[]
  now?: number
}

// Must match the Worker (scripts/live-playback-worker.mjs).
export const DEVICE_ONLINE_MS = 45_000
// A paused session on another open device stays in control for this long, so it can be resumed from here.
export const PAUSED_REMOTE_MS = 60_000
// A playing device that stopped checking in (an iPhone in the background suspends the page) is trusted
// until its current track would have finished, but never longer than this.
export const SILENT_PLAYING_MAX_MS = 15 * 60_000
// Commands older than this are dropped rather than acted on late (a throttled background tab, a reload).
export const COMMAND_MAX_AGE_MS = 30_000

interface Optimistic {
  fields: Partial<LivePlaybackSnapshot>
  baseRevision: number
  until: number
}

interface LivePlaybackState {
  snapshot: LivePlaybackSnapshot | null
  devices: LivePlaybackDevice[]
  connected: boolean
  // Server clock minus this device's clock, so ages are measured on one clock across devices.
  serverOffset: number
  optimistic: Optimistic | null
  setSnapshot(snapshot: LivePlaybackSnapshot | null): void
  setConnected(connected: boolean): void
  applyServer(response: LivePlaybackResponse, serverOffset?: number): void
  applyOptimistic(fields: Partial<LivePlaybackSnapshot>): void
}

function makeDeviceId() {
  if (typeof window === 'undefined') return 'server'
  const key = 'tomify-device-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const value = crypto.randomUUID()
  window.localStorage.setItem(key, value)
  return value
}

export function deviceNameFromUserAgent(agent: string, standalone = false) {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : ''
  let platform = 'Web'
  if (/iPhone/i.test(agent)) platform = 'iPhone'
  else if (/iPad/i.test(agent)) platform = 'iPad'
  else if (/Android/i.test(agent)) platform = 'Android'
  else if (/Macintosh|Mac OS X/i.test(agent)) platform = 'Mac'
  else if (/Windows/i.test(agent)) platform = 'Windows'
  if (standalone) return `${platform} app`
  return browser && platform !== 'Web' ? `${platform} · ${browser}` : platform
}

function makeDeviceName() {
  if (typeof navigator === 'undefined') return 'Web'
  const standalone = typeof window !== 'undefined' && (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
  return deviceNameFromUserAgent(navigator.userAgent, standalone)
}

export const localPlaybackDeviceId = makeDeviceId()
export const localPlaybackDeviceName = makeDeviceName()

function authHeaders(): Record<string, string> | undefined {
  const session = useAuth.getState().session
  if (!session) return undefined
  return {
    'x-tomify-user': session.username,
    'x-tomify-token': session.token,
    'x-tomify-salt': session.salt,
  }
}

function mergeOptimistic(snapshot: LivePlaybackSnapshot | null, optimistic: Optimistic | null, now: number) {
  if (!snapshot || !optimistic || now > optimistic.until || snapshot.revision > optimistic.baseRevision) return { snapshot, optimistic: null }
  return { snapshot: { ...snapshot, ...optimistic.fields }, optimistic }
}

export const useLivePlayback = create<LivePlaybackState>((set, get) => ({
  snapshot: null,
  devices: [],
  connected: false,
  serverOffset: 0,
  optimistic: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setConnected: (connected) => set({ connected }),
  applyServer: (response, serverOffset) => {
    const offset = serverOffset ?? get().serverOffset
    // Keep a just-sent command's effect on screen until the other device reports back with a newer revision.
    const merged = mergeOptimistic(response.state, get().optimistic, Date.now() + offset)
    set({ snapshot: merged.snapshot, optimistic: merged.optimistic, devices: response.devices ?? [], serverOffset: offset, connected: true })
  },
  applyOptimistic: (fields) => {
    const { snapshot, serverOffset } = get()
    if (!snapshot) return
    const now = Date.now() + serverOffset
    const previous = get().optimistic
    const optimistic = { fields: { ...(previous && now <= previous.until ? previous.fields : {}), ...fields }, baseRevision: snapshot.revision, until: now + 4000 }
    set({ snapshot: { ...snapshot, ...fields }, optimistic })
  },
}))

export function serverNow() {
  return Date.now() + useLivePlayback.getState().serverOffset
}

export function isDeviceOnline(devices: LivePlaybackDevice[], deviceId: string, now: number) {
  return devices.some((device) => device.deviceId === deviceId && now - device.lastSeen < DEVICE_ONLINE_MS)
}

export function livePosition(snapshot: LivePlaybackSnapshot, now: number) {
  const elapsed = snapshot.playing ? Math.max(0, now - snapshot.updatedAt) / 1000 : 0
  return Math.min(snapshot.duration || Infinity, snapshot.currentTime + elapsed)
}

// The other device whose playback this device should show and control, or null to show local playback.
export function activeRemoteSession(snapshot: LivePlaybackSnapshot | null, devices: LivePlaybackDevice[], now: number, localDeviceId = localPlaybackDeviceId) {
  if (!snapshot || snapshot.deviceId === localDeviceId || !snapshot.queue[snapshot.currentIndex]) return null
  const online = isDeviceOnline(devices, snapshot.deviceId, now)
  const age = now - snapshot.updatedAt
  if (snapshot.playing) {
    if (online) return snapshot
    const duration = snapshot.duration || snapshot.queue[snapshot.currentIndex]?.duration || 0
    const stillInTrack = duration > 0 && snapshot.currentTime + age / 1000 < duration + 5
    return stillInTrack && age < SILENT_PLAYING_MAX_MS ? snapshot : null
  }
  return online && age < PAUSED_REMOTE_MS ? snapshot : null
}

export function currentRemoteSession() {
  const state = useLivePlayback.getState()
  return activeRemoteSession(state.snapshot, state.devices, serverNow())
}

// Commands this device should act on: aimed at it, newer than the last one handled, and still fresh.
export function pendingCommands(response: LivePlaybackResponse, lastRevision: number, now: number, localDeviceId = localPlaybackDeviceId) {
  const commands = response.commands ?? (response.command ? [response.command] : [])
  return commands
    .filter((command) => command.targetDeviceId === localDeviceId && command.revision > lastRevision && now - command.updatedAt <= COMMAND_MAX_AGE_MS)
    .sort((a, b) => a.revision - b.revision)
}

export function latestCommandRevision(response: LivePlaybackResponse) {
  const commands = response.commands ?? (response.command ? [response.command] : [])
  return commands.reduce((latest, command) => Math.max(latest, command.revision), 0)
}

export async function fetchLivePlayback(): Promise<{ response: LivePlaybackResponse; serverOffset?: number } | null> {
  const headers = authHeaders()
  if (!headers) return null
  const query = new URLSearchParams({ deviceId: localPlaybackDeviceId, deviceName: localPlaybackDeviceName })
  const sentAt = Date.now()
  const result = await window.fetch(`/api/live-playback?${query}`, { headers, cache: 'no-store' })
  if (!result.ok) throw new Error('Live playback unavailable')
  const response = await result.json() as LivePlaybackResponse
  const receivedAt = Date.now()
  const serverOffset = typeof response.now === 'number' ? response.now - (sentAt + receivedAt) / 2 : undefined
  return { response, serverOffset }
}

export class LivePlaybackConflict extends Error {}

export async function publishLivePlayback(snapshot: Omit<LivePlaybackSnapshot, 'updatedAt' | 'revision'>, takeover = false): Promise<LivePlaybackSnapshot> {
  const headers = authHeaders()
  if (!headers) throw new Error('Not signed in')
  const response = await window.fetch('/api/live-playback', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ...snapshot, takeover }),
  })
  if (response.status === 409) throw new LivePlaybackConflict('Another device took over playback')
  if (!response.ok) throw new Error('Could not publish live playback')
  const body = await response.json() as { state: LivePlaybackSnapshot }
  return body.state
}

// Called as the page goes away: keepalive lets the request finish after the tab closes or reloads.
export function leaveLivePlayback(currentTime: number) {
  const headers = authHeaders()
  if (!headers) return
  try {
    void window.fetch('/api/live-playback/leave', {
      method: 'POST',
      keepalive: true,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: localPlaybackDeviceId, currentTime }),
    }).catch(() => undefined)
  } catch { /* page is unloading */ }
}

export async function sendLivePlaybackCommand(targetDeviceId: string, action: LivePlaybackCommandAction, value?: number, track?: Track) {
  const headers = authHeaders()
  if (!headers) return false
  const response = await window.fetch('/api/live-playback/command', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ targetDeviceId, action, value, track }),
  })
  if (response.ok && typeof window !== 'undefined') window.dispatchEvent(new Event(LIVE_PLAYBACK_ACTIVITY_EVENT))
  return response.ok
}

// Fired after a remote command is sent so the sync loop checks back quickly for the result.
export const LIVE_PLAYBACK_ACTIVITY_EVENT = 'tomify-live-playback-activity'

// What a command will do to the other device's state, shown straight away instead of after a round trip.
export function optimisticFields(snapshot: LivePlaybackSnapshot, action: LivePlaybackCommandAction, now: number, value?: number, track?: Track): Partial<LivePlaybackSnapshot> | null {
  switch (action) {
    case 'play': return { playing: true, currentTime: livePosition(snapshot, now), updatedAt: now }
    case 'pause': return { playing: false, currentTime: livePosition(snapshot, now), updatedAt: now }
    case 'seek': return typeof value === 'number' ? { currentTime: value, updatedAt: now } : null
    case 'toggle-shuffle': return { shuffle: !snapshot.shuffle }
    case 'cycle-repeat': return { repeat: snapshot.repeat === 'off' ? 'all' : snapshot.repeat === 'all' ? 'one' : 'off' }
    case 'toggle-muted': return { muted: !snapshot.muted }
    case 'set-volume': return typeof value === 'number' ? { volume: value } : null
    case 'add-to-queue': return track ? { queue: [...snapshot.queue, track] } : null
    default: return null
  }
}

const debouncedCommands = new Map<string, number>()

// Controls a remote device: updates this screen at once, then sends the command. Sliders (seek, volume) are
// debounced so dragging sends one command instead of dozens.
export function controlRemote(snapshot: LivePlaybackSnapshot, action: LivePlaybackCommandAction, value?: number, track?: Track) {
  const fields = optimisticFields(snapshot, action, serverNow(), value, track)
  if (fields) useLivePlayback.getState().applyOptimistic(fields)
  if (action === 'seek' || action === 'set-volume') {
    const key = `${snapshot.deviceId}:${action}`
    window.clearTimeout(debouncedCommands.get(key))
    debouncedCommands.set(key, window.setTimeout(() => {
      debouncedCommands.delete(key)
      void sendLivePlaybackCommand(snapshot.deviceId, action, value)
    }, 250))
    return
  }
  void sendLivePlaybackCommand(snapshot.deviceId, action, value, track)
}

export interface PollConditions {
  hidden: boolean
  playingHere: boolean
  remoteActive: boolean
  remotePlaying: boolean
  burst: boolean
  idleRounds: number
}

// How long to wait before the next check. The device that is playing keeps checking even in a background tab,
// because that is how it hears pause or skip from another device; everything else slows down when idle or hidden.
export function nextPollDelay({ hidden, playingHere, remoteActive, remotePlaying, burst, idleRounds }: PollConditions) {
  if (playingHere) return hidden ? 2000 : 1500
  if (hidden) return 20_000
  if (burst) return 1000
  if (remotePlaying) return 1500
  if (remoteActive) return 3000
  return Math.min(10_000, Math.round(2000 * 1.5 ** idleRounds))
}

// The remote session to show, re-evaluated every `tickMs` so progress moves and stale sessions drop away.
export function useRemoteSession(tickMs = 1000) {
  const snapshot = useLivePlayback((state) => state.snapshot)
  const devices = useLivePlayback((state) => state.devices)
  const serverOffset = useLivePlayback((state) => state.serverOffset)
  const [now, setNow] = useState(() => Date.now() + serverOffset)
  const remote = activeRemoteSession(snapshot, devices, now)
  const watching = Boolean(snapshot && snapshot.deviceId !== localPlaybackDeviceId)
  useEffect(() => {
    setNow(Date.now() + serverOffset)
    if (!watching) return
    const timer = window.setInterval(() => setNow(Date.now() + serverOffset), tickMs)
    return () => window.clearInterval(timer)
  }, [watching, serverOffset, tickMs, snapshot])
  return { remote, now }
}
