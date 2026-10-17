// "Made for you": mixes built from the account's own library and listening history.
// Tomify gathers a pool of candidate songs (on repeat, favourites, similar songs, new and unplayed albums),
// builds simple mixes from it, and, when an Anthropic API key is configured, asks Claude to pick, order and
// name the mixes instead. Mixes are stored per account in D1 and rebuilt about once a day.
import type { Env, RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { subsonicForRequest, type SubsonicCall } from '../lib/subsonic.ts'
import { curateMixesWithClaude, type CuratorRequest, type CuratedMix } from './mix-curator.ts'

const DAY_MS = 24 * 60 * 60 * 1000
// Mixes older than this are rebuilt the next time Home opens.
export const MIX_STALE_MS = 20 * 60 * 60 * 1000
// A manual refresh is ignored if the mixes were built this recently.
export const MIX_MANUAL_REFRESH_MS = 10 * 60 * 1000
// A refresh that started this long ago is assumed to have died, so another can start.
export const MIX_REFRESH_TIMEOUT_MS = 3 * 60 * 1000
const MIX_MIN_TRACKS = 8
const MIX_MAX_TRACKS = 30
const MAX_CANDIDATES_FOR_CLAUDE = 350

export interface MixTrack {
  id: string
  title: string
  artist: string
  album: string
  artistId?: string
  albumId?: string
  coverArt?: string
  duration?: number
  track?: number
  discNumber?: number
  suffix?: string
  contentType?: string
  starred?: string
}

export interface Mix {
  id: string
  title: string
  description: string
  kind: string
  tracks: MixTrack[]
  coverArt: string[]
}

export interface SubsonicSong extends MixTrack {
  year?: number
  genre?: string
  playCount?: number
  played?: string
}

export interface ListeningStat {
  trackId: string
  artistId: string | null
  artist: string | null
  plays: number
  skips: number
  completions: number
  lastPlayed: number
}

export interface Candidate {
  song: SubsonicSong
  sources: string[]
  playCount: number
  lastPlayed: number | null
  recentPlays: number
  recentSkips: number
  starred: boolean
}

export interface LibrarySnapshot {
  songs: { song: SubsonicSong, source: string }[]
  stats: ListeningStat[]
  topArtists: string[]
}

// ---- Gathering ----

interface AlbumSummary { id: string, name?: string, artist?: string, artistId?: string, playCount?: number }

const songsOf = (value: unknown): SubsonicSong[] => Array.isArray(value) ? value.filter((song): song is SubsonicSong => Boolean(song && typeof song.id === 'string' && typeof song.title === 'string')) : []

async function albumList(subsonic: SubsonicCall, type: string, size: number): Promise<AlbumSummary[]> {
  const result = await subsonic<{ albumList2?: { album?: AlbumSummary[] } }>('getAlbumList2', { type, size })
  return result.albumList2?.album ?? []
}

// Artists listened to most in the last 30 days (skips count against them); falls back to the most played albums.
export function topArtistsFrom(stats: ListeningStat[], frequentAlbums: AlbumSummary[], limit = 5): string[] {
  const now = Date.now()
  const scores = new Map<string, number>()
  for (const stat of stats) {
    if (!stat.artist || stat.lastPlayed < now - 30 * DAY_MS) continue
    scores.set(stat.artist, (scores.get(stat.artist) ?? 0) + stat.plays - stat.skips)
  }
  const fromHistory = [...scores.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).map(([artist]) => artist)
  const fromAlbums = frequentAlbums.map((album) => album.artist).filter((artist): artist is string => Boolean(artist))
  return [...new Set([...fromHistory, ...fromAlbums])].slice(0, limit)
}

export async function listeningStats(env: Env, username: string, now: number): Promise<ListeningStat[]> {
  const result = await env.TOMIFY_DB.prepare('SELECT track_id AS trackId, MAX(artist_id) AS artistId, MAX(artist) AS artist, COUNT(*) AS plays, SUM(skipped) AS skips, SUM(completed) AS completions, MAX(played_at) AS lastPlayed FROM listening_events WHERE username = ? AND played_at >= ? GROUP BY track_id ORDER BY plays DESC LIMIT 400')
    .bind(username, now - 180 * DAY_MS).all<ListeningStat>()
  return (result.results ?? []).map((row) => ({ ...row, plays: Number(row.plays), skips: Number(row.skips ?? 0), completions: Number(row.completions ?? 0), lastPlayed: Number(row.lastPlayed) }))
}

export async function gatherLibrary(subsonic: SubsonicCall, stats: ListeningStat[]): Promise<LibrarySnapshot> {
  const [frequent, recent, newest, starred, random] = await Promise.all([
    albumList(subsonic, 'frequent', 30),
    albumList(subsonic, 'recent', 30),
    albumList(subsonic, 'newest', 24),
    subsonic<{ starred2?: { song?: unknown } }>('getStarred2'),
    subsonic<{ randomSongs?: { song?: unknown } }>('getRandomSongs', { size: 200 }),
  ])
  const songs: LibrarySnapshot['songs'] = []
  const add = (list: SubsonicSong[], source: string) => { for (const song of list) songs.push({ song, source }) }
  add(songsOf(starred.starred2?.song), 'favourite')
  add(songsOf(random.randomSongs?.song), 'library')

  const topArtists = topArtistsFrom(stats, frequent)
  const artistIds = new Map<string, string>()
  for (const album of [...frequent, ...recent]) if (album.artist && album.artistId && !artistIds.has(album.artist)) artistIds.set(album.artist, album.artistId)
  for (const stat of stats) if (stat.artist && stat.artistId && !artistIds.has(stat.artist)) artistIds.set(stat.artist, stat.artistId)

  const albumsToOpen: { id: string, source: string }[] = []
  for (const album of frequent.slice(0, 6)) albumsToOpen.push({ id: album.id, source: 'most-played-album' })
  for (const album of recent.slice(0, 3)) albumsToOpen.push({ id: album.id, source: 'recently-played-album' })
  for (const album of newest.slice(0, 6)) albumsToOpen.push({ id: album.id, source: 'recently-added' })
  const seenAlbums = new Set<string>()

  // A missing Last.fm/ListenBrainz/Deezer agent or one bad album shouldn't stop the whole build.
  const optional = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback)
  const lookups = await Promise.all([
    ...topArtists.map(async (artist) => {
      const [top, similar] = await Promise.all([
        optional(subsonic<{ topSongs?: { song?: unknown } }>('getTopSongs', { artist, count: 15 }), {}),
        artistIds.has(artist) ? optional(subsonic<{ similarSongs2?: { song?: unknown } }>('getSimilarSongs2', { id: artistIds.get(artist), count: 30 }), {}) : Promise.resolve({}),
      ])
      return [
        { list: songsOf((top as { topSongs?: { song?: unknown } }).topSongs?.song), source: `top-songs:${artist}` },
        { list: songsOf((similar as { similarSongs2?: { song?: unknown } }).similarSongs2?.song), source: `similar-to:${artist}` },
      ]
    }),
    ...albumsToOpen.filter(({ id }) => !seenAlbums.has(id) && seenAlbums.add(id)).map(async ({ id, source }) => {
      const album = await optional(subsonic<{ album?: { song?: unknown } }>('getAlbum', { id }), {} as { album?: { song?: unknown } })
      return [{ list: songsOf(album.album?.song), source }]
    }),
  ])
  for (const group of lookups) for (const { list, source } of group) add(list, source)
  return { songs, stats, topArtists }
}

// ---- Candidates ----

export function buildCandidates(snapshot: LibrarySnapshot, now: number): Candidate[] {
  const stats = new Map(snapshot.stats.map((stat) => [stat.trackId, stat]))
  const byId = new Map<string, Candidate>()
  for (const { song, source } of snapshot.songs) {
    const existing = byId.get(song.id)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      if (source === 'favourite') existing.starred = true
      continue
    }
    const stat = stats.get(song.id)
    const recent = stat && stat.lastPlayed >= now - 30 * DAY_MS
    const navidromePlayed = song.played ? Date.parse(song.played) : NaN
    const lastPlayed = Math.max(stat?.lastPlayed ?? 0, Number.isFinite(navidromePlayed) ? navidromePlayed : 0) || null
    byId.set(song.id, {
      song,
      sources: [source],
      playCount: Math.max(Number(song.playCount ?? 0), stat?.plays ?? 0),
      lastPlayed,
      recentPlays: recent ? stat.plays : 0,
      recentSkips: recent ? stat.skips : 0,
      starred: Boolean(song.starred) || source === 'favourite',
    })
  }
  // Songs you keep skipping are left out of every mix.
  return [...byId.values()].filter((candidate) => !(candidate.recentSkips >= 2 && candidate.recentSkips * 2 > candidate.recentPlays))
}

// ---- Simple mixes (used without Claude, and as the fallback when Claude is unavailable) ----

// A small seeded random so a day's mixes are stable between refreshes and tests are repeatable.
export function seededRandom(seed: string) {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619)
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507)
    state = Math.imul(state ^ (state >>> 13), 3266489909)
    state ^= state >>> 16
    return (state >>> 0) / 4294967296
  }
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

// Reorders so the same artist doesn't play twice in a row where that can be avoided.
export function spreadArtists<T extends { artist: string }>(tracks: T[]): T[] {
  const remaining = [...tracks]
  const result: T[] = []
  while (remaining.length) {
    const previous = result[result.length - 1]?.artist
    // Take the next track from whichever other artist has the most left, so no artist is left bunched at the end.
    const left = new Map<string, number>()
    for (const track of remaining) left.set(track.artist, (left.get(track.artist) ?? 0) + 1)
    let index = -1
    remaining.forEach((track, position) => { if (track.artist !== previous && (index === -1 || left.get(track.artist)! > left.get(remaining[index].artist)!)) index = position })
    result.push(...remaining.splice(index === -1 ? 0 : index, 1))
  }
  return result
}

function limitPerArtist(candidates: Candidate[], perArtist: number) {
  const counts = new Map<string, number>()
  return candidates.filter((candidate) => {
    const count = counts.get(candidate.song.artist) ?? 0
    counts.set(candidate.song.artist, count + 1)
    return count < perArtist
  })
}

export function toMixTrack(song: SubsonicSong): MixTrack {
  const track: MixTrack = { id: song.id, title: String(song.title ?? ''), artist: String(song.artist ?? ''), album: String(song.album ?? '') }
  for (const key of ['artistId', 'albumId', 'coverArt', 'suffix', 'contentType', 'starred'] as const) if (typeof song[key] === 'string') track[key] = song[key]
  for (const key of ['duration', 'track', 'discNumber'] as const) if (typeof song[key] === 'number') track[key] = song[key]
  return track
}

export function makeMix(kind: string, title: string, description: string, songs: SubsonicSong[], index: number): Mix | null {
  const seen = new Set<string>()
  const tracks = songs.filter((song) => !seen.has(song.id) && seen.add(song.id)).slice(0, MIX_MAX_TRACKS).map(toMixTrack)
  if (tracks.length < MIX_MIN_TRACKS) return null
  const coverArt = [...new Set(tracks.map((track) => track.coverArt || track.albumId).filter((id): id is string => Boolean(id)))].slice(0, 4)
  return { id: `mix-${index + 1}`, title: title.trim().slice(0, 80), description: description.trim().slice(0, 240), kind, tracks, coverArt }
}

export function buildSimpleMixes(candidates: Candidate[], topArtists: string[], now: number, seed: string): Mix[] {
  const random = seededRandom(seed)
  const drafts: { kind: string, title: string, description: string, songs: SubsonicSong[] }[] = []
  const pick = (list: Candidate[], size = 25) => spreadArtists(list.slice(0, size).map((candidate) => candidate.song))

  const onRepeat = candidates.filter((candidate) => candidate.recentPlays >= 2 || (candidate.playCount >= 3 && (candidate.lastPlayed ?? 0) >= now - 30 * DAY_MS))
    .sort((a, b) => b.recentPlays - a.recentPlays || b.playCount - a.playCount)
  drafts.push({ kind: 'on-repeat', title: 'On repeat', description: 'The songs you keep coming back to this month.', songs: pick(limitPerArtist(onRepeat, 8)) })

  for (const artist of topArtists.slice(0, 3)) {
    const own = shuffled(candidates.filter((candidate) => candidate.song.artist === artist), random).slice(0, 8)
    const similar = shuffled(candidates.filter((candidate) => candidate.sources.includes(`similar-to:${artist}`) && candidate.song.artist !== artist), random)
    drafts.push({ kind: 'artist-mix', title: `${artist} mix`, description: `${artist} and music that sits well alongside it.`, songs: spreadArtists([...own, ...limitPerArtist(similar, 3)].slice(0, 25).map((candidate) => candidate.song)) })
  }

  const rediscover = shuffled(candidates.filter((candidate) => (candidate.starred || candidate.playCount >= 3) && candidate.recentPlays === 0 && (candidate.lastPlayed === null || candidate.lastPlayed < now - 120 * DAY_MS)), random)
  drafts.push({ kind: 'rediscover', title: 'Rediscover', description: 'Old favourites you haven\'t played in a while.', songs: pick(limitPerArtist(rediscover, 2)) })

  const fresh = shuffled(candidates.filter((candidate) => candidate.sources.includes('recently-added') && candidate.playCount === 0), random)
  drafts.push({ kind: 'fresh', title: 'Fresh finds', description: 'Unplayed songs from albums you added recently.', songs: pick(limitPerArtist(fresh, 4)) })

  const loved = new Set(topArtists)
  const deepCuts = shuffled(candidates.filter((candidate) => candidate.playCount === 0 && !candidate.sources.includes('recently-added') && (loved.has(candidate.song.artist) || candidate.sources.some((source) => source.startsWith('similar-to:')))), random)
  drafts.push({ kind: 'deep-cuts', title: 'Deep cuts', description: 'Songs by artists you love that you\'ve never played.', songs: pick(limitPerArtist(deepCuts, 3)) })

  return drafts.map((draft, index) => makeMix(draft.kind, draft.title, draft.description, draft.songs, index)).filter((mix): mix is Mix => mix !== null).map((mix, index) => ({ ...mix, id: `mix-${index + 1}` }))
}

// ---- Claude ----

const shortDate = (time: number | null) => time ? new Date(time).toISOString().slice(0, 7) : 'never'

export function curatorRequest(candidates: Candidate[], snapshot: LibrarySnapshot, now: number): { request: CuratorRequest, refs: Map<string, SubsonicSong> } {
  // Prefer songs with a reason to be there over random library picks when the pool is too big.
  const ranked = [...candidates].sort((a, b) => Number(b.sources.some((source) => source !== 'library')) - Number(a.sources.some((source) => source !== 'library')))
  const chosen = ranked.slice(0, MAX_CANDIDATES_FOR_CLAUDE)
  const refs = new Map<string, SubsonicSong>()
  const lines = chosen.map((candidate, index) => {
    const ref = `t${index + 1}`
    refs.set(ref, candidate.song)
    const song = candidate.song
    const details = [song.year, song.genre].filter(Boolean).join(', ')
    const listening = `plays ${candidate.playCount}, last ${shortDate(candidate.lastPlayed)}${candidate.recentPlays ? `, ${candidate.recentPlays} this month` : ''}${candidate.recentSkips ? `, skipped ${candidate.recentSkips}` : ''}${candidate.starred ? ', favourite' : ''}`
    return `${ref} | ${song.artist} - ${song.title} | ${song.album}${details ? ` (${details})` : ''} | ${listening} | ${candidate.sources.join(', ')}`
  })
  const skipped = snapshot.stats.filter((stat) => stat.skips >= 2 && stat.skips * 2 > stat.plays).map((stat) => stat.artist).filter(Boolean)
  const profile = [
    `Today: ${new Date(now).toUTCString().slice(0, 16)}.`,
    `Artists played most lately: ${snapshot.topArtists.join(', ') || 'not enough history yet'}.`,
    skipped.length ? `Often skipped lately: ${[...new Set(skipped)].slice(0, 10).join(', ')}.` : '',
    `Listening history covers ${snapshot.stats.reduce((total, stat) => total + stat.plays, 0)} recorded plays in the last six months.`,
  ].filter(Boolean).join('\n')
  return { request: { profile, candidates: lines.join('\n') }, refs }
}

export function mixesFromCurated(curated: CuratedMix[], refs: Map<string, SubsonicSong>): Mix[] {
  return curated
    .map((mix, index) => makeMix('claude', mix.title, mix.description, mix.trackRefs.map((ref) => refs.get(ref.trim())).filter((song): song is SubsonicSong => Boolean(song)), index))
    .filter((mix): mix is Mix => mix !== null)
    .slice(0, 6)
    .map((mix, index) => ({ ...mix, id: `mix-${index + 1}` }))
}

// ---- Building and storing ----

export interface BuildResult { mixes: Mix[], curatedBy: string, warning: string | null }

export interface MixDependencies {
  curate?: (env: Env, request: CuratorRequest) => Promise<CuratedMix[]>
}

export async function buildMixes(env: Env, username: string, subsonic: SubsonicCall, now: number, deps: MixDependencies = {}): Promise<BuildResult> {
  const stats = await listeningStats(env, username, now)
  const snapshot = await gatherLibrary(subsonic, stats)
  const candidates = buildCandidates(snapshot, now)
  const seed = `${username}:${new Date(now).toISOString().slice(0, 10)}`
  const simple = buildSimpleMixes(candidates, snapshot.topArtists, now, seed)
  if (!env.ANTHROPIC_API_KEY) return { mixes: simple, curatedBy: 'tomify', warning: null }
  try {
    const { request, refs } = curatorRequest(candidates, snapshot, now)
    const curated = mixesFromCurated(await (deps.curate ?? curateMixesWithClaude)(env, request), refs)
    if (curated.length >= 2) return { mixes: curated, curatedBy: 'claude', warning: null }
    return { mixes: simple, curatedBy: 'tomify', warning: 'Claude returned too few usable mixes, so Tomify built them itself.' }
  } catch (error) {
    return { mixes: simple, curatedBy: 'tomify', warning: `Claude was unavailable (${error instanceof Error ? error.message : String(error)}), so Tomify built the mixes itself.` }
  }
}

interface StoredRow { mixesJson: string, generatedAt: number | null, curatedBy: string | null, refreshStartedAt: number | null, lastError: string | null }

function present(row: StoredRow | null, env: Env, now: number) {
  let mixes: Mix[] = []
  try { mixes = row ? JSON.parse(row.mixesJson) : [] } catch { mixes = [] }
  const generatedAt = row?.generatedAt ? Number(row.generatedAt) : null
  return {
    mixes,
    generatedAt,
    curatedBy: row?.curatedBy ?? null,
    refreshing: Boolean(row?.refreshStartedAt && Number(row.refreshStartedAt) > now - MIX_REFRESH_TIMEOUT_MS),
    stale: !generatedAt || generatedAt < now - MIX_STALE_MS,
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    lastError: row?.lastError ?? null,
  }
}

const selectRow = (env: Env, username: string) => env.TOMIFY_DB.prepare('SELECT mixes_json AS mixesJson, generated_at AS generatedAt, curated_by AS curatedBy, refresh_started_at AS refreshStartedAt, last_error AS lastError FROM made_for_you WHERE username = ?').bind(username).first<StoredRow>()

export function createMixesHandler(deps: MixDependencies & { fetcher?: typeof fetch } = {}): RouteHandler {
  return async (request, env, url) => {
    if (url.pathname !== '/api/mixes' && url.pathname !== '/api/mixes/refresh') return null
    if (!env?.TOMIFY_DB) return json({ error: 'mixes-store-unavailable' }, 503)
    const signedIn = await authenticate(request, env)
    if (!signedIn) return json({ error: 'unauthorized' }, 401)
    const username = signedIn.toLowerCase()
    const now = Date.now()

    if (url.pathname === '/api/mixes') {
      if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
      return json(present(await selectRow(env, username), env, now))
    }

    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    const body = await request.json().catch(() => ({})) as { force?: unknown }
    const current = present(await selectRow(env, username), env, now)
    const recentEnough = current.generatedAt !== null && current.generatedAt > now - (body.force === true ? MIX_MANUAL_REFRESH_MS : MIX_STALE_MS)
    if (recentEnough) return json(current)

    // Claim the refresh so two open tabs don't both build (and both pay for) a set of mixes.
    const claim = await env.TOMIFY_DB.prepare('INSERT INTO made_for_you (username, refresh_started_at) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET refresh_started_at = excluded.refresh_started_at WHERE made_for_you.refresh_started_at IS NULL OR made_for_you.refresh_started_at < ?')
      .bind(username, now, now - MIX_REFRESH_TIMEOUT_MS).run()
    if (!claim.meta?.changes) return json({ ...current, refreshing: true }, 202)

    try {
      const result = await buildMixes(env, username, subsonicForRequest(request, signedIn, env, deps.fetcher), now, deps)
      await env.TOMIFY_DB.prepare('UPDATE made_for_you SET mixes_json = ?, generated_at = ?, curated_by = ?, refresh_started_at = NULL, last_error = ? WHERE username = ?')
        .bind(JSON.stringify(result.mixes), now, result.curatedBy, result.warning, username).run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await env.TOMIFY_DB.prepare('UPDATE made_for_you SET refresh_started_at = NULL, last_error = ? WHERE username = ?').bind(message, username).run()
      return json({ ...present(await selectRow(env, username), env, Date.now()), error: 'mixes-build-failed', message: `Tomify couldn't build your mixes: ${message}` }, 502)
    }
    return json(present(await selectRow(env, username), env, Date.now()))
  }
}

export const handleMixesRequest = createMixesHandler()
