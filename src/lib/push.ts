import { useAuth } from '../stores/auth'

export type PushTopic = 'recovery' | 'new-releases'

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// iPhones and iPads only allow notifications for Tomify added to the Home Screen and opened from there.
export function needsHomeScreen(userAgent = navigator.userAgent, standalone = isStandalone()) {
  return /iPhone|iPad|iPod/.test(userAgent) && !standalone
}

function isStandalone() {
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
}

export function keyBytes(base64Url: string) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (character) => character.charCodeAt(0))
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to manage notifications.')
  const response = await fetch(path, { ...init, headers: { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || body.error || 'Notifications are unavailable.')
  return body
}

export const pushApi = {
  state: (endpoint?: string) => request<{ publicKey: string | null; topics: PushTopic[] | null }>(`/api/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  save: (subscription: PushSubscriptionJSON, topics: PushTopic[]) => request<{ topics: PushTopic[] }>('/api/push/subscription', { method: 'PUT', body: JSON.stringify({ subscription, topics }) }),
  test: () => request<{ sent: number }>('/api/push/test', { method: 'POST' }),
}

export async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

export async function subscribe(publicKey: string) {
  const registration = await navigator.serviceWorker.ready
  return (await registration.pushManager.getSubscription()) ?? registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
}
