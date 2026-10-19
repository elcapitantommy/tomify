// Party mode: a signed-in host starts a party, and guests join it with an access code from their phones (no Tomify
// login) to search the library and add tracks to a shared queue. The host's player pulls the next track from that
// queue (src/stores/party.ts) and plays it, so guests never stream anything themselves.
// Guests search with a party login (TOMIFY_PARTY_USERNAME/PASSWORD) when one is set, otherwise with the host's own
// Navidrome token, sealed with TOMIFY_MEDIA_KEY and deleted when the party ends.
import type { D1Database } from '@cloudflare/workers-types'
import type { Env, RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { navidromeUrl } from '../lib/navidrome.ts'
import { seal, unseal } from '../lib/seal.ts'
import type { SubsonicCall } from '../lib/subsonic.ts'

// A party ends on its own once the host's player has not checked in for this long.
export const PARTY_IDLE_MS = 12 * 60 * 60 * 1000
// Tracks played this recently can't be added again.
export const PARTY_REPEAT_MS = 60 * 60 * 1000
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const MAX_GUESTS = 60
const MAX_JOIN_FAILURES = 20
const joinFailures = new Map<string, { count: number; since: number }>()

interface PartyRow { id: string; username: string; name: string; code: string; credential: string; cooldown: number; maxPerGuest: number; voting: number; nowPlaying: string | null; seenAt: number }
interface ItemRow { id: string; guestId: string | null; guestName: string; trackJson: string; state: string; addedAt: number; votes: number }
export interface PartyItem { id: string; guestId: string | null; guestName: string; state: string; addedAt: number; votes: number; track: Record<string, unknown> }

const PARTY_COLUMNS = 'id, username, name, code, credential, cooldown_seconds AS cooldown, max_per_guest AS maxPerGuest, voting, now_playing_json AS nowPlaying, seen_at AS seenAt'
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const whole = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
export const normaliseCode = (value: unknown) => text(value, 20).toUpperCase().replace(/[^A-Z0-9]/g, '')

// The fields of a Subsonic song the player needs; whatever else Navidrome sends is dropped.
const TRACK_FIELDS = ['id', 'title', 'artist', 'artistId', 'album', 'albumId', 'coverArt', 'duration', 'track', 'discNumber', 'year', 'genre', 'suffix', 'contentType', 'size', 'bpm', 'replayGain']
export function partyTrack(song: Record<string, unknown>) {
  return Object.fromEntries(TRACK_FIELDS.filter((key) => song[key] !== undefined && song[key] !== null).map((key) => [key, song[key]]))
}

// Most votes first (when voting is on); otherwise, and between equal votes, guests take turns, so one person
// adding five tracks doesn't fill the next five slots.
export function orderPartyQueue<T extends { guestId: string | null; addedAt: number; votes: number; state: string }>(items: T[], voting: boolean): T[] {
  const turns = new Map<T, number>()
  const seen = new Map<string, number>()
  for (const item of [...items].sort((a, b) => a.addedAt - b.addedAt)) {
    const guest = item.guestId ?? 'host'
    const turn = seen.get(guest) ?? 0
    seen.set(guest, turn + 1)
    turns.set(item, turn)
  }
  const queued = (item: T) => item.state === 'queued' ? 0 : 1
  return [...items].sort((a, b) => queued(a) - queued(b) || (voting ? b.votes - a.votes : 0) || turns.get(a)! - turns.get(b)! || a.addedAt - b.addedAt)
}

async function endParty(db: D1Database, id: string) {
  await db.batch([
    db.prepare('DELETE FROM party_votes WHERE item_id IN (SELECT id FROM party_queue WHERE party_id = ?)').bind(id),
    db.prepare('DELETE FROM party_queue WHERE party_id = ?').bind(id),
    db.prepare('DELETE FROM party_guests WHERE party_id = ?').bind(id),
    db.prepare('DELETE FROM parties WHERE id = ?').bind(id),
  ])
}

async function liveParty(db: D1Database, where: string, value: string, now: number) {
  const party = await db.prepare(`SELECT ${PARTY_COLUMNS} FROM parties WHERE ${where} = ?`).bind(value).first<PartyRow>()
  if (party && now - party.seenAt > PARTY_IDLE_MS) { await endParty(db, party.id); return null }
  return party
}

async function partyItems(db: D1Database, party: PartyRow): Promise<PartyItem[]> {
  const rows = (await db.prepare(`SELECT q.id, q.guest_id AS guestId, q.guest_name AS guestName, q.track_json AS trackJson, q.state, q.added_at AS addedAt, (SELECT COUNT(*) FROM party_votes v WHERE v.item_id = q.id) AS votes
    FROM party_queue q WHERE q.party_id = ? AND q.state != 'played'`).bind(party.id).all<ItemRow>()).results || []
  const items = rows.map(({ trackJson, ...row }) => { let track = {}; try { track = JSON.parse(trackJson) } catch { /* unreadable rows show as blank */ } return { ...row, votes: Number(row.votes) || 0, track } })
  return orderPartyQueue(items, Boolean(party.voting))
}

function settings(party: PartyRow, env: Env) {
  return { id: party.id, name: party.name, code: party.code, cooldownSeconds: party.cooldown, maxPerGuest: party.maxPerGuest, voting: Boolean(party.voting), partyLogin: Boolean(partyLogin(env)) }
}

function nowPlaying(party: PartyRow) {
  try { return party.nowPlaying ? JSON.parse(party.nowPlaying) : null } catch { return null }
}

const partyLogin = (env: Env) => env.TOMIFY_PARTY_USERNAME && env.TOMIFY_PARTY_PASSWORD ? { u: env.TOMIFY_PARTY_USERNAME, p: env.TOMIFY_PARTY_PASSWORD } : null

// Navidrome as the party login, or as the host with the token they started the party with.
const loginFor = async (env: Env, party: PartyRow): Promise<Record<string, string>> => partyLogin(env) ?? JSON.parse(await unseal(env.TOMIFY_MEDIA_KEY || '', party.credential))
async function partySubsonic(env: Env, party: PartyRow): Promise<SubsonicCall> {
  const login = await loginFor(env, party)
  return async <T>(endpoint: string, params: Record<string, string | number | undefined> = {}) => {
    const url = navidromeUrl(env, `/rest/${endpoint}.view`)
    for (const [key, value] of Object.entries({ ...login, v: '1.16.1', c: 'Tomify', f: 'json', ...params })) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    const body = await response.json().catch(() => null) as { 'subsonic-response'?: { status?: string } & Record<string, unknown> } | null
    const data = body?.['subsonic-response']
    if (!response.ok || data?.status !== 'ok') throw new Error(`Navidrome ${endpoint} failed.`)
    return data as T
  }
}

async function newCode(db: D1Database) {
  for (;;) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('')
    if (!await db.prepare('SELECT id FROM parties WHERE code = ?').bind(code).first()) return code
  }
}

async function hostRequest(request: Request, env: Env, path: string, now: number) {
  const signedIn = await authenticate(request, env)
  if (!signedIn) return json({ error: 'unauthorized' }, 401)
  const username = signedIn.toLowerCase()
  const db = env.TOMIFY_DB
  const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => null) as Record<string, unknown> | null
  if (path === '' && request.method === 'POST') {
    if (!partyLogin(env) && !env.TOMIFY_MEDIA_KEY) return json({ error: 'party-unavailable', message: 'Party mode needs TOMIFY_MEDIA_KEY or a party login set on the Worker.' }, 503)
    const old = await db.prepare('SELECT id FROM parties WHERE username = ?').bind(username).first<{ id: string }>()
    if (old) await endParty(db, old.id)
    const credential = partyLogin(env) ? '' : await seal(env.TOMIFY_MEDIA_KEY!, JSON.stringify({ u: signedIn, t: request.headers.get('x-tomify-token'), s: request.headers.get('x-tomify-salt') }))
    await db.prepare('INSERT INTO parties (id, username, name, code, credential, cooldown_seconds, max_per_guest, voting, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), username, text(body?.name, 80) || 'Tomify party', await newCode(db), credential, whole(body?.cooldownSeconds, 0, 3600, 0), whole(body?.maxPerGuest, 1, 50, 3), body?.voting === false ? 0 : 1, now, now).run()
  }
  const party = await liveParty(db, 'username', username, now)
  if (!party) return path === '' && request.method === 'GET' ? json({ party: null }) : json({ error: 'not-found' }, 404)
  if (path === '' && request.method === 'DELETE') { await endParty(db, party.id); return json({ ended: true }) }
  if (path === '' && request.method === 'PATCH') {
    const playing = body && 'nowPlaying' in body ? (body.nowPlaying && typeof body.nowPlaying === 'object' ? JSON.stringify(partyTrack(body.nowPlaying as Record<string, unknown>)) : null) : party.nowPlaying
    Object.assign(party, { name: text(body?.name, 80) || party.name, cooldown: whole(body?.cooldownSeconds, 0, 3600, party.cooldown), maxPerGuest: whole(body?.maxPerGuest, 1, 50, party.maxPerGuest), voting: typeof body?.voting === 'boolean' ? Number(body.voting) : party.voting, nowPlaying: playing })
    await db.prepare('UPDATE parties SET name = ?, cooldown_seconds = ?, max_per_guest = ?, voting = ?, now_playing_json = ? WHERE id = ?').bind(party.name, party.cooldown, party.maxPerGuest, party.voting, party.nowPlaying, party.id).run()
  }
  const item = path.match(/^\/items\/([\w-]{1,64})$/)
  if (item && request.method === 'DELETE') await db.prepare('DELETE FROM party_queue WHERE id = ? AND party_id = ?').bind(item[1], party.id).run()
  if (item && request.method === 'POST') {
    const state = body?.state === 'played' ? 'played' : body?.state === 'queued' ? 'queued' : 'pending'
    await db.prepare('UPDATE party_queue SET state = ?, state_at = ? WHERE id = ? AND party_id = ?').bind(state, now, item[1], party.id).run()
  }
  const guest = path.match(/^\/guests\/([\w-]{1,64})$/)
  if (guest && request.method === 'DELETE') {
    await db.batch([
      db.prepare("DELETE FROM party_queue WHERE guest_id = ? AND party_id = ? AND state = 'pending'").bind(guest[1], party.id),
      db.prepare('DELETE FROM party_guests WHERE id = ? AND party_id = ?').bind(guest[1], party.id),
    ])
  }
  if (path !== '' && !item && !guest) return json({ error: 'not-found' }, 404)
  // Every host request is the host's player checking in, which keeps the party alive.
  await db.prepare('UPDATE parties SET seen_at = ? WHERE id = ?').bind(now, party.id).run()
  const guests = (await db.prepare('SELECT id, name, joined_at AS joinedAt FROM party_guests WHERE party_id = ? ORDER BY joined_at').bind(party.id).all()).results || []
  return json({ party: settings(party, env), nowPlaying: nowPlaying(party), queue: await partyItems(db, party), guests }, request.method === 'POST' && path === '' ? 201 : 200)
}

async function join(request: Request, env: Env, now: number) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const failures = joinFailures.get(ip)
  if (failures && now - failures.since < 10 * 60 * 1000 && failures.count >= MAX_JOIN_FAILURES) return json({ error: 'too-many-attempts', message: 'Too many wrong codes. Try again in a few minutes.' }, 429)
  const body = await request.json().catch(() => null) as { code?: unknown; name?: unknown } | null
  const name = text(body?.name, 40)
  if (!name) return json({ error: 'name-required', message: 'Enter your name.' }, 400)
  const party = await liveParty(env.TOMIFY_DB, 'code', normaliseCode(body?.code), now)
  if (!party) {
    joinFailures.set(ip, failures && now - failures.since < 10 * 60 * 1000 ? { ...failures, count: failures.count + 1 } : { count: 1, since: now })
    return json({ error: 'not-found', message: 'No party has that code.' }, 404)
  }
  const count = await env.TOMIFY_DB.prepare('SELECT COUNT(*) AS count FROM party_guests WHERE party_id = ?').bind(party.id).first<{ count: number }>()
  if ((count?.count || 0) >= MAX_GUESTS) return json({ error: 'party-full', message: 'This party is full.' }, 409)
  const token = randomHex(24)
  await env.TOMIFY_DB.prepare('INSERT INTO party_guests (id, party_id, name, token, joined_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), party.id, name, token, now).run()
  return json({ token, name: party.name }, 201)
}

async function guestRequest(request: Request, env: Env, url: URL, path: string, now: number) {
  const db = env.TOMIFY_DB
  const token = request.headers.get('x-tomify-party') || url.searchParams.get('t') || ''
  const guest = token ? await db.prepare('SELECT id, party_id AS partyId, name, last_added_at AS lastAddedAt FROM party_guests WHERE token = ?').bind(token).first<{ id: string; partyId: string; name: string; lastAddedAt: number }>() : null
  const party = guest ? await liveParty(db, 'id', guest.partyId, now) : null
  if (!guest || !party) return json({ error: 'party-ended', message: 'This party has ended.' }, 401)
  const cover = path.match(/^\/cover\/([\w-]{1,100})$/)
  if (cover) {
    // getCoverArt answers with an image, not JSON, so it is fetched directly with the party's login.
    const coverUrl = navidromeUrl(env, '/rest/getCoverArt.view')
    for (const [key, value] of Object.entries({ ...await loginFor(env, party), v: '1.16.1', c: 'Tomify', id: cover[1], size: '300' })) coverUrl.searchParams.set(key, value)
    const image = await fetch(coverUrl)
    return new Response(image.body, { status: image.status, headers: { 'content-type': image.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' } })
  }
  if (path === '/search') {
    const query = text(url.searchParams.get('q'), 100)
    if (!query) return json({ tracks: [] })
    const result = await (await partySubsonic(env, party))<{ searchResult3?: { song?: Record<string, unknown>[] } }>('search3', { query, artistCount: 0, albumCount: 0, songCount: 30 })
    return json({ tracks: (result.searchResult3?.song ?? []).map(partyTrack) })
  }
  const items = await partyItems(db, party)
  const mine = items.filter((item) => item.guestId === guest.id)
  if (path === '/queue' && request.method === 'POST') {
    const trackId = text((await request.json().catch(() => null) as { trackId?: unknown } | null)?.trackId, 100)
    if (!trackId) return json({ error: 'track-required' }, 400)
    const nextAddAt = guest.lastAddedAt + party.cooldown * 1000
    if (nextAddAt > now) return json({ error: 'cooldown', message: `You can add another track in ${Math.ceil((nextAddAt - now) / 1000)} seconds.`, nextAddAt }, 429)
    if (mine.filter((item) => item.state === 'pending').length >= party.maxPerGuest) return json({ error: 'too-many', message: `You already have ${party.maxPerGuest} waiting. Add more once one has played.` }, 409)
    if (items.some((item) => item.track.id === trackId)) return json({ error: 'already-queued', message: 'That track is already in the queue.' }, 409)
    if (await db.prepare("SELECT id FROM party_queue WHERE party_id = ? AND track_id = ? AND state = 'played' AND state_at > ?").bind(party.id, trackId, now - PARTY_REPEAT_MS).first()) return json({ error: 'recently-played', message: 'That track played in the last hour.' }, 409)
    const song = (await (await partySubsonic(env, party))<{ song?: Record<string, unknown> }>('getSong', { id: trackId }).catch(() => ({ song: undefined }))).song
    if (!song) return json({ error: 'track-not-found', message: 'That track is not in the library.' }, 404)
    await db.batch([
      db.prepare('INSERT INTO party_queue (id, party_id, guest_id, guest_name, track_id, track_json, added_at, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), party.id, guest.id, guest.name, trackId, JSON.stringify(partyTrack(song)), now, now),
      db.prepare('UPDATE party_guests SET last_added_at = ? WHERE id = ?').bind(now, guest.id),
    ])
    guest.lastAddedAt = now
  }
  const item = path.match(/^\/(queue|vote)\/([\w-]{1,64})$/)
  const target = item && items.find((entry) => entry.id === item[2] && entry.state === 'pending')
  if (item && !target) return json({ error: 'not-found', message: 'That track is no longer waiting.' }, 404)
  if (target && item?.[1] === 'queue' && request.method === 'DELETE') {
    if (target.guestId !== guest.id) return json({ error: 'forbidden' }, 403)
    await db.batch([db.prepare('DELETE FROM party_votes WHERE item_id = ?').bind(target.id), db.prepare('DELETE FROM party_queue WHERE id = ?').bind(target.id)])
  }
  if (target && item?.[1] === 'vote' && request.method === 'POST') {
    if (!party.voting) return json({ error: 'voting-off' }, 409)
    const voted = await db.prepare('SELECT item_id FROM party_votes WHERE item_id = ? AND guest_id = ?').bind(target.id, guest.id).first()
    await db.prepare(voted ? 'DELETE FROM party_votes WHERE item_id = ? AND guest_id = ?' : 'INSERT INTO party_votes (item_id, guest_id) VALUES (?, ?)').bind(target.id, guest.id).run()
  }
  if (path !== '' && path !== '/queue' && !item) return json({ error: 'not-found' }, 404)
  const voted = new Set(((await db.prepare('SELECT item_id AS itemId FROM party_votes WHERE guest_id = ?').bind(guest.id).all<{ itemId: string }>()).results || []).map((row) => row.itemId))
  const queue = (await partyItems(db, party)).map(({ guestId, ...entry }) => ({ ...entry, mine: guestId === guest.id, voted: voted.has(entry.id) }))
  return json({ party: { name: party.name, voting: Boolean(party.voting), cooldownSeconds: party.cooldown, maxPerGuest: party.maxPerGuest }, me: { name: guest.name, nextAddAt: guest.lastAddedAt + party.cooldown * 1000 }, nowPlaying: nowPlaying(party), queue }, request.method === 'POST' && path === '/queue' ? 201 : 200)
}

export const handlePartyRequest: RouteHandler = async (request, env, url) => {
  const match = url.pathname.match(/^\/api\/party(\/.*)?$/)
  if (!match) return null
  if (!env?.TOMIFY_DB) return json({ error: 'party-unavailable' }, 503)
  const path = match[1] ?? ''
  const now = Date.now()
  if (path === '/join' && request.method === 'POST') return join(request, env, now)
  if (path === '/guest' || path.startsWith('/guest/')) return guestRequest(request, env, url, path.slice(6), now)
  return hostRequest(request, env, path, now)
}
