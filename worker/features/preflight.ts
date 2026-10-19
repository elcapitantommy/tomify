// Duplicate preflight (task 13): before Recovery downloads something, what Tom already has of it, in the recovery
// library (the agent's read-only POST /v1/preflight) and in the master library (Navidrome search3).
// `GET /api/recovery/:id/preflight?mode=release|track` returns `{ recovery, library }`; either is null when that
// side could not be checked, for example an agent from before /v1/preflight, which answers 404.
//
// The pure helpers are exported for tests. handlePreflightRequest relies on Worker globals (json, authenticate,
// isNavidromeAdmin, recoveryItem, callRecoveryAgent, and navidromeCall from library-scan-worker.mjs).

import type { Env } from '../env.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { callRecoveryAgent } from '../lib/agent.ts'
import { json } from '../lib/http.ts'
import { isNavidromeConfigurationError } from '../lib/navidrome.ts'
import { recoveryItem } from '../routes/recovery.ts'
import { navidromeCall } from './library-scan.ts'

export type PreflightMode = 'release' | 'track'
export interface PreflightTarget { artist: string; album: string; title: string; mode: PreflightMode }
type PreflightItem = { artist?: string | null; album?: string | null; title?: string | null; metadataResolution?: { metadata?: Record<string, unknown> | null } | null }
// A track the agent found in the recovery library, as /v1/preflight returns it.
type AgentTrack = { title?: string | null; trackNumber?: number | null; discNumber?: number | null; recordingId?: string | null; tier?: string | null; path?: string | null }
// The search3 album and song fields preflight reads.
type SearchEntry = { id?: string; name?: string; title?: string; artist?: string; displayArtist?: string; albumArtist?: string; album?: string; path?: string; songCount?: number }

export function preflightText(value: unknown): string {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
/** What to check for: the wanted item, with blanks filled from its MusicBrainz match. A whole-album item checks the release. */
export function preflightTarget(item: PreflightItem | null | undefined, requestedMode: string | null | undefined): PreflightTarget {
  const matched = item?.metadataResolution?.metadata || {}
  const pick = (field: 'artist' | 'album' | 'title') => String(item?.[field] || matched[field] || '').trim().slice(0, 240)
  const title = pick('title')
  const mode = requestedMode === 'release' || requestedMode === 'track' ? requestedMode : title ? 'track' : 'release'
  return { artist: pick('artist'), album: pick('album'), title, mode }
}

function artistMatches(target: PreflightTarget, ...names: Array<string | undefined>) {
  const artist = preflightText(target.artist)
  return !artist || names.some((name) => preflightText(name) === artist)
}

/** Recovery tracks that count as already there: the whole directory for a release, the same title for a track. */
export function recoveryPreflightMatches(existing: unknown, target: PreflightTarget) {
  const tracks: AgentTrack[] = Array.isArray(existing) ? existing : []
  const wanted = preflightText(target.title)
  const matches = target.mode === 'release' || !wanted ? tracks : tracks.filter((track) => preflightText(track.title) === wanted)
  return matches.map((track) => ({ title: String(track.title || ''), trackNumber: track.trackNumber ?? null, discNumber: track.discNumber ?? null, recordingId: track.recordingId || null, tier: track.tier || 'unknown', path: track.path || null }))
}

/** Navidrome albums (release mode) or songs (track mode) by the same artist with the same title. */
export function libraryPreflightMatches(searchResult: { album?: SearchEntry[]; song?: SearchEntry[] } | null | undefined, target: PreflightTarget) {
  if (target.mode === 'release') {
    const album = preflightText(target.album)
    if (!album) return []
    return (Array.isArray(searchResult?.album) ? searchResult.album : [] as SearchEntry[])
      .filter((value) => value?.id && preflightText(value.name || value.title) === album && artistMatches(target, value.artist, value.displayArtist))
      .map((value) => ({ kind: 'album', id: value.id, title: String(value.name || value.title || ''), artist: value.artist || null, songCount: Number.isFinite(value.songCount) ? value.songCount : null }))
  }
  const title = preflightText(target.title)
  if (!title) return []
  return (Array.isArray(searchResult?.song) ? searchResult.song : [] as SearchEntry[])
    .filter((value) => value?.id && preflightText(value.title) === title && artistMatches(target, value.artist, value.displayArtist, value.albumArtist))
    .map((value) => ({ kind: 'song', id: value.id, title: String(value.title || ''), artist: value.artist || null, album: value.album || null, path: value.path || null }))
}

export async function handlePreflightRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/recovery\/([^/]+)\/preflight$/)
  if (!match) return null
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
  if (!env?.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can use Recovery.' }, 403)
  const item = await recoveryItem(env.TOMIFY_DB, username, decodeURIComponent(match[1]))
  if (!item) return json({ error: 'recovery-item-not-found' }, 404)
  const target = preflightTarget(item, url.searchParams.get('mode'))

  let recovery: ReturnType<typeof recoveryPreflightMatches> | null = null
  let directory: string | null = null
  try {
    const result = await callRecoveryAgent(env, '/v1/preflight', target)
    directory = result.directory || null
    recovery = recoveryPreflightMatches(result.existing, target)
  } catch { /* an older agent (404), or none configured: the recovery side is unknown */ }

  let library: ReturnType<typeof libraryPreflightMatches> | null = null
  const query = target.mode === 'release' ? target.album : target.title
  if (query) {
    try {
      const result = await navidromeCall(request, env, 'search3', target.mode === 'release' ? { query, albumCount: 20, songCount: 0, artistCount: 0 } : { query, songCount: 50, albumCount: 0, artistCount: 0 })
      library = libraryPreflightMatches(result.searchResult3, target)
    } catch (error) {
      if (isNavidromeConfigurationError(error)) throw error
      /* Navidrome unreachable: the library side is unknown */
    }
  } else library = []
  return json({ target, directory, recovery, library })
}
