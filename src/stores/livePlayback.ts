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

export interface LivePlaybackCommand {
  revision: number
  targetDeviceId: string
  action: LivePlaybackCommandAction
  value?: number
  updatedAt: number
}

interface LivePlaybackState {
  snapshot: LivePlaybackSnapshot | null
  connected: boolean
  setSnapshot(snapshot: LivePlaybackSnapshot | null): void
  setConnected(connected: boolean): void
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

function makeDeviceName() {
  if (typeof navigator === 'undefined') return 'Web'
  const agent = navigator.userAgent
  if (/iPhone/i.test(agent)) return 'iPhone'
  if (/iPad/i.test(agent)) return 'iPad'
  if (/Android/i.test(agent)) return 'Android'
  if (/Macintosh|Mac OS X/i.test(agent)) return 'Mac'
  if (/Windows/i.test(agent)) return 'Windows'
  return 'Web'
}

export const localPlaybackDeviceId = makeDeviceId()
export const localPlaybackDeviceName = makeDeviceName()

function authHeaders(): HeadersInit | undefined {
  const session = useAuth.getState().session
  if (!session) return undefined
  return {
    'x-tomify-user': session.username,
    'x-tomify-token': session.token,
    'x-tomify-salt': session.salt,
  }
}

export const useLivePlayback = create<LivePlaybackState>((set) => ({
  snapshot: null,
  connected: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setConnected: (connected) => set({ connected }),
}))

export async function fetchLivePlayback(): Promise<{ state: LivePlaybackSnapshot | null; command: LivePlaybackCommand | null }> {
  const headers = authHeaders()
  if (!headers) return { state: null, command: null }
  const response = await window.fetch('/api/live-playback', { headers, cache: 'no-store' })
  if (!response.ok) throw new Error('Live playback unavailable')
  return response.json() as Promise<{ state: LivePlaybackSnapshot | null; command: LivePlaybackCommand | null }>
}

export async function publishLivePlayback(snapshot: Omit<LivePlaybackSnapshot, 'updatedAt' | 'revision'>): Promise<LivePlaybackSnapshot> {
  const headers = authHeaders()
  if (!headers) throw new Error('Not signed in')
  const response = await window.fetch('/api/live-playback', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!response.ok) throw new Error('Could not publish live playback')
  const body = await response.json() as { state: LivePlaybackSnapshot }
  return body.state
}

export async function sendLivePlaybackCommand(targetDeviceId: string, action: LivePlaybackCommandAction, value?: number) {
  const headers = authHeaders()
  if (!headers) return false
  const response = await window.fetch('/api/live-playback/command', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ targetDeviceId, action, value }),
  })
  return response.ok
}
