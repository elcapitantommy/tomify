import type { RouteHandler } from '../env.ts'
import { handleCompletenessRequest } from '../features/completeness.ts'
import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { lookupMusicBrainzReleaseGroup, musicBrainzType, rowToItem, selectRelease, type ReleaseMetadataRow } from './recovery.ts'

interface ReleaseAlbumInput { albumId?: string, name?: string, artist?: string, force?: boolean, replaceManual?: boolean }
interface ReleaseUpdateInput { releaseType?: string, releaseDate?: string }

export const releaseMetadataRoute: RouteHandler = async (request, env, url) => {
  const completeness = await handleCompletenessRequest(request, env, url)
  if (completeness) return completeness
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/api/release-meta' && request.method === 'GET') {
    if (!env?.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
    const username = await authenticate(request, env)
    if (!username) return json({ error: 'unauthorized' }, 401)
    const result = await env.TOMIFY_DB.prepare('SELECT album_id AS albumId, release_type AS releaseType, release_date AS releaseDate, updated_at AS updatedAt, source, musicbrainz_id AS musicBrainzId, match_score AS matchScore FROM release_metadata ORDER BY album_id').all<ReleaseMetadataRow>()
    return json({ items: (result.results || []).map(rowToItem) })
  }

  if (pathname === '/api/release-meta/enrich' && request.method === 'POST') {
    if (!env?.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
    const username = await authenticate(request, env)
    if (!username) return json({ error: 'unauthorized' }, 401)
    const album = await request.json() as ReleaseAlbumInput
    if (!album || typeof album.albumId !== 'string' || typeof album.name !== 'string' || typeof album.artist !== 'string') return json({ error: 'invalid-album' }, 400)

    const existing = await selectRelease(env.TOMIFY_DB, album.albumId)
    const force = album.force === true
    const replaceManual = album.replaceManual === true
    if (existing && (!force || (existing.source === 'manual' && !replaceManual))) return json({ item: existing, cached: true })
    if (existing && !(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can edit release metadata.' }, 403)

    const match = await lookupMusicBrainzReleaseGroup(album)
    if (!match?.group) return json({ error: 'musicbrainz-no-match' }, 404)
    const releaseType = musicBrainzType(match.group)
    const releaseDate = typeof match.group['first-release-date'] === 'string' && /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(match.group['first-release-date']) ? match.group['first-release-date'] : null
    const groupId = typeof match.group.id === 'string' ? match.group.id : null
    await env.TOMIFY_DB.prepare("INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by, source, musicbrainz_id, match_score) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'musicbrainz', ?, ?) ON CONFLICT(album_id) DO UPDATE SET release_type = excluded.release_type, release_date = excluded.release_date, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by, source = 'musicbrainz', musicbrainz_id = excluded.musicbrainz_id, match_score = excluded.match_score")
      .bind(album.albumId, releaseType, releaseDate, username, groupId, match.score).run()
    const item = await selectRelease(env.TOMIFY_DB, album.albumId)
    return json({ item, cached: false })
  }

  const releaseMetaMatch = pathname.match(/^\/api\/release-meta\/([^/]+)$/)
  if (releaseMetaMatch && request.method === 'PUT') {
    if (!env?.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
    const username = await authenticate(request, env)
    if (!username) return json({ error: 'unauthorized' }, 401)
    if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can edit release metadata.' }, 403)
    const body = await request.json() as ReleaseUpdateInput
    const allowed = ['album', 'single', 'ep', 'compilation', 'other']
    if (!body || typeof body.releaseType !== 'string' || !allowed.includes(body.releaseType)) return json({ error: 'invalid-release-type' }, 400)
    const releaseDate = typeof body.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate) ? body.releaseDate : null
    await env.TOMIFY_DB.prepare("INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by, source) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'manual') ON CONFLICT(album_id) DO UPDATE SET release_type = excluded.release_type, release_date = excluded.release_date, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by, source = 'manual'")
      .bind(releaseMetaMatch[1], body.releaseType, releaseDate, username).run()
    const item = await selectRelease(env.TOMIFY_DB, releaseMetaMatch[1])
    return json({ ok: true, item })
  }
  return null
}
