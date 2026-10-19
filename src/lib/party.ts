import type { Track } from '../types'
import { useAuth } from '../stores/auth'

// Party mode (worker/features/party.ts): the host's calls carry their Navidrome login; guests carry the token
// /api/party/join gave them.
export interface PartySettings { id: string; name: string; code: string; cooldownSeconds: number; maxPerGuest: number; voting: boolean; partyLogin: boolean }
export interface PartyItem { id: string; guestId?: string | null; guestName: string; state: 'pending' | 'queued'; addedAt: number; votes: number; track: Track; mine?: boolean; voted?: boolean }
export interface PartyGuest { id: string; name: string; joinedAt: number }
export interface HostParty { party: PartySettings | null; nowPlaying?: Track | null; queue?: PartyItem[]; guests?: PartyGuest[] }
export interface GuestParty { party: { name: string; voting: boolean; cooldownSeconds: number; maxPerGuest: number }; me: { name: string; nextAddAt: number }; nowPlaying: Track | null; queue: PartyItem[] }
export type PartyOptions = Partial<Pick<PartySettings, 'name' | 'cooldownSeconds' | 'maxPerGuest' | 'voting'>>

export class PartyError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message) } }

async function call<T>(path: string, headers: HeadersInit, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/party${path}`, { ...init, headers: { ...headers, 'content-type': 'application/json' } })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new PartyError(body.message || body.error || 'Party mode is unavailable.', response.status, body.error)
  return body
}
const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

function hostHeaders(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to host a party.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
}

export const partyHostApi = {
  load: () => call<HostParty>('', hostHeaders()),
  start: (options: PartyOptions) => call<HostParty>('', hostHeaders(), send('POST', options)),
  update: (changes: PartyOptions & { nowPlaying?: Track | null }) => call<HostParty>('', hostHeaders(), send('PATCH', changes)),
  end: () => call<{ ended: true }>('', hostHeaders(), send('DELETE')),
  setState: (itemId: string, state: 'queued' | 'played' | 'pending') => call<HostParty>(`/items/${encodeURIComponent(itemId)}`, hostHeaders(), send('POST', { state })),
  remove: (itemId: string) => call<HostParty>(`/items/${encodeURIComponent(itemId)}`, hostHeaders(), send('DELETE')),
  removeGuest: (guestId: string) => call<HostParty>(`/guests/${encodeURIComponent(guestId)}`, hostHeaders(), send('DELETE')),
}

export const partyGuestApi = {
  join: (code: string, name: string) => call<{ token: string; name: string }>('/join', {}, send('POST', { code, name })),
  load: (token: string) => call<GuestParty>('/guest', { 'x-tomify-party': token }),
  search: (token: string, query: string, signal?: AbortSignal) => call<{ tracks: Track[] }>(`/guest/search?q=${encodeURIComponent(query)}`, { 'x-tomify-party': token }, { signal }),
  add: (token: string, trackId: string) => call<GuestParty>('/guest/queue', { 'x-tomify-party': token }, send('POST', { trackId })),
  remove: (token: string, itemId: string) => call<GuestParty>(`/guest/queue/${encodeURIComponent(itemId)}`, { 'x-tomify-party': token }, send('DELETE')),
  vote: (token: string, itemId: string) => call<GuestParty>(`/guest/vote/${encodeURIComponent(itemId)}`, { 'x-tomify-party': token }, send('POST')),
  coverUrl: (token: string, coverArt?: string) => coverArt ? `/api/party/guest/cover/${encodeURIComponent(coverArt)}?t=${encodeURIComponent(token)}` : '',
}

export const partyJoinUrl = (code: string) => `${window.location.origin}/join/${code}`

// What the host's player should do next: the party tracks it already has up next, and the waiting one to add.
// Only one party track is up next at a time, so votes keep reordering the rest until it is their turn.
export function nextPartyStep(queue: PartyItem[], playerQueue: Track[], currentIndex: number) {
  const current = playerQueue[currentIndex]
  const upcoming = playerQueue.slice(Math.max(0, currentIndex + 1))
  const played: PartyItem[] = []
  let waiting = false
  for (const item of queue.filter((entry) => entry.state === 'queued')) {
    if (current?.id === item.track.id) played.push(item)
    else if (upcoming.some((track) => track.id === item.track.id)) waiting = true
    else played.push(item)
  }
  const add = waiting ? null : queue.find((item) => item.state === 'pending') ?? null
  return { played, add }
}
