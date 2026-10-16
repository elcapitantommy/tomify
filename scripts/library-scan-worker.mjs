// Library scan after a recovery import: an imported file is not playable in Tomify until Navidrome has
// scanned it. The item keeps its Recovered or Needs-upgrade status and gains a `playback` record (D1
// column recovery_items.playback_json): `scan-pending` from the import until search3 finds the track,
// then `ready` with the Navidrome song id, or `scan-failed` when it is still missing after ten minutes.
//
// The pure helpers are exported for tests. The Worker functions rely on Worker globals (json,
// authenticate, isNavidromeAdmin, recoveryItem, ensureRecoveryTables).

export const PLAYBACK_CHECK_INTERVAL_MS = 15_000
export const PLAYBACK_TIMEOUT_MS = 10 * 60_000

export function libraryScanText(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function parseRecoveryPlayback(value) {
  try {
    const playback = value ? JSON.parse(value) : null
    return playback && ['scan-pending', 'ready', 'scan-failed'].includes(playback.state) ? playback : null
  } catch { return null }
}

/** The track to look for in the library after the selected candidate was imported, or null before an import. */
export function recoveryPlaybackTarget(item) {
  const candidate = (Array.isArray(item?.candidates) ? item.candidates : []).find((value) => value.selected && value.importedPath)
  if (!candidate) return null
  const provenance = candidate.provenance || {}
  const tracks = Array.isArray(provenance.importedTracks) ? provenance.importedTracks.filter((track) => track && (track.path || track.title)) : []
  // A release import plays the track the item asked for when there is one, otherwise its first track.
  const track = (item.title && tracks.find((value) => libraryScanText(value.title) === libraryScanText(item.title))) || tracks[0] || null
  const metadata = provenance.resolvedMetadata || {}
  const title = track?.title || metadata.title || item.title || ''
  const artist = track?.artist || track?.albumArtist || metadata.artist || item.artist || ''
  const recordingId = metadata.recordingId || item.musicBrainzId || null
  return {
    path: track?.path || candidate.importedPath,
    title: String(title).slice(0, 240),
    artist: String(artist).slice(0, 240),
    recordingId: typeof recordingId === 'string' && recordingId ? recordingId : null,
    // One import is one key, so polling a finished job again does not restart the wait.
    key: [candidate.id, provenance.job?.id || '', candidate.importedPath].join(':'),
  }
}

export function pendingRecoveryPlayback(target, now = Date.now()) {
  return { state: 'scan-pending', key: target.key, target: { path: target.path, title: target.title, artist: target.artist, recordingId: target.recordingId }, since: new Date(now).toISOString(), checkedAt: null, scanRequestedAt: null }
}

function pathsMatch(importedPath, libraryPath) {
  const imported = String(importedPath || '').replace(/\\/g, '/').toLocaleLowerCase('en')
  const library = String(libraryPath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLocaleLowerCase('en')
  if (!imported || !library) return false
  return imported === library || imported.endsWith('/' + library) || imported.split('/').pop() === library.split('/').pop()
}

/** The Navidrome song for the target: by MusicBrainz recording id, else title and artist filtered by path when Navidrome reports one. */
export function matchLibrarySong(songs, target) {
  const list = (Array.isArray(songs) ? songs : []).filter((song) => song && typeof song.id === 'string' && song.id)
  if (target?.recordingId) {
    const byRecording = list.find((song) => song.musicBrainzId === target.recordingId && (!song.path || !target.path || pathsMatch(target.path, song.path)))
    if (byRecording) return byRecording
  }
  const title = libraryScanText(target?.title)
  const artist = libraryScanText(target?.artist)
  if (!title) return null
  const named = list.filter((song) => libraryScanText(song.title) === title && (!artist || [song.artist, song.displayArtist, song.albumArtist].some((value) => libraryScanText(value) === artist)))
  // A same-named track elsewhere in the library is not the imported copy.
  return named.find((song) => song.path && target.path && pathsMatch(target.path, song.path)) || named.find((song) => !song.path || !target.path) || null
}

/** A pending record is due for a library check when it was never checked or was last checked 15 s ago. */
export function playbackCheckDue(playback, now = Date.now()) {
  if (playback?.state !== 'scan-pending') return false
  const checkedAt = Date.parse(playback.checkedAt || '')
  return !Number.isFinite(checkedAt) || now - checkedAt >= PLAYBACK_CHECK_INTERVAL_MS
}

export function playbackTimedOut(playback, now = Date.now()) {
  const since = Date.parse(playback?.since || '')
  return Number.isFinite(since) && now - since >= PLAYBACK_TIMEOUT_MS
}

async function navidromeCall(request, endpoint, params = {}) {
  const url = new URL('https://tomify.tomdixon.uk/rest/' + endpoint + '.view')
  const base = { u: request.headers.get('x-tomify-user') || '', t: request.headers.get('x-tomify-token') || '', s: request.headers.get('x-tomify-salt') || '', v: '1.16.1', c: 'Tomify', f: 'json' }
  for (const [key, value] of Object.entries({ ...base, ...params })) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('Navidrome answered ' + response.status + ' to ' + endpoint + '.')
  const body = await response.json()
  const subsonic = body && body['subsonic-response']
  if (!subsonic || subsonic.status !== 'ok') throw new Error(subsonic?.error?.message || 'Navidrome rejected ' + endpoint + '.')
  return subsonic
}

/** Starts a quick (not full) library scan unless one is already running. */
async function requestLibraryScan(request) {
  const status = await navidromeCall(request, 'getScanStatus')
  if (status.scanStatus?.scanning) return { started: false, running: true }
  await navidromeCall(request, 'startScan')
  return { started: true, running: true }
}

async function findImportedSong(request, target) {
  const queries = [...new Set([[target.artist, target.title].filter(Boolean).join(' '), target.title].filter(Boolean))]
  for (const query of queries) {
    const result = await navidromeCall(request, 'search3', { query, songCount: 20, artistCount: 0, albumCount: 0 })
    const song = matchLibrarySong(result.searchResult3?.song, target)
    if (song) return song
  }
  return null
}

async function saveRecoveryPlayback(db, username, id, playback) {
  await db.prepare('UPDATE recovery_items SET playback_json = ? WHERE id = ? AND username = ?').bind(JSON.stringify(playback), id, username).run()
}

/** Called once an import completes: records `scan-pending` and asks Navidrome for a scan. Never throws. */
async function markRecoveryScanPending(request, db, username, id) {
  try {
    const item = await recoveryItem(db, username, id)
    const target = recoveryPlaybackTarget(item)
    if (!target || item.playback?.key === target.key) return
    const playback = pendingRecoveryPlayback(target)
    try { if ((await requestLibraryScan(request)).started) playback.scanRequestedAt = new Date().toISOString() }
    catch { /* the first library check asks again */ }
    await saveRecoveryPlayback(db, username, id, playback)
  } catch { /* the import itself succeeded; a missing playback record only hides the scan state */ }
}

async function refreshRecoveryPlayback(request, db, username, item) {
  const playback = item.playback
  if (!playbackCheckDue(playback)) return item
  const now = Date.now()
  const next = { ...playback, checkedAt: new Date(now).toISOString() }
  let song = null
  try { song = await findImportedSong(request, playback.target || {}) }
  catch (error) { next.lastError = error instanceof Error ? error.message.slice(0, 300) : 'Navidrome could not be searched.' }
  if (song) {
    Object.assign(next, { state: 'ready', songId: song.id, readyAt: next.checkedAt, lastError: null })
  } else if (playbackTimedOut(playback, now)) {
    Object.assign(next, { state: 'scan-failed', failedAt: next.checkedAt })
  } else if (!playback.scanRequestedAt) {
    // A scan that was already running when the file landed may have passed its folder, so start one of our own.
    try { if ((await requestLibraryScan(request)).started) next.scanRequestedAt = next.checkedAt }
    catch { /* try again on the next check */ }
  }
  await saveRecoveryPlayback(db, username, item.id, next)
  return recoveryItem(db, username, item.id)
}

async function handleLibraryScanRequest(request, env, url) {
  const match = url.pathname.match(/^\/api\/recovery\/([^/]+)\/playback(\/retry)?$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  if (!env?.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (!(await isNavidromeAdmin(request, username))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can use Recovery.' }, 403)
  const db = env.TOMIFY_DB
  await ensureRecoveryTables(db)
  const id = decodeURIComponent(match[1])
  const item = await recoveryItem(db, username, id)
  if (!item) return json({ error: 'recovery-item-not-found' }, 404)
  if (match[2]) {
    const target = recoveryPlaybackTarget(item)
    if (!target) return json({ error: 'recovery-not-imported', message: 'Import this item before checking the library for it.' }, 409)
    const playback = pendingRecoveryPlayback(target)
    try { if ((await requestLibraryScan(request)).started) playback.scanRequestedAt = playback.since }
    catch { /* the next library check asks again */ }
    await saveRecoveryPlayback(db, username, id, playback)
    return json({ item: await recoveryItem(db, username, id) })
  }
  return json({ item: await refreshRecoveryPlayback(request, db, username, item) })
}

export const libraryScanWorkerSource = [
  `const PLAYBACK_CHECK_INTERVAL_MS = ${PLAYBACK_CHECK_INTERVAL_MS}`,
  `const PLAYBACK_TIMEOUT_MS = ${PLAYBACK_TIMEOUT_MS}`,
  ...[libraryScanText, parseRecoveryPlayback, recoveryPlaybackTarget, pendingRecoveryPlayback, pathsMatch, matchLibrarySong, playbackCheckDue, playbackTimedOut,
    navidromeCall, requestLibraryScan, findImportedSong, saveRecoveryPlayback, markRecoveryScanPending, refreshRecoveryPlayback, handleLibraryScanRequest].map((fn) => fn.toString()),
].join('\n\n')
