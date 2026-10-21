import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { handlePlaylistShareRequest } from '../worker/features/playlist-share.ts'
import { listeningHistory } from '../worker/features/listening.ts'

function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({ bind: (...next) => statement(sql, next), first: async () => db.prepare(sql).get(...values) ?? null, all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }) })
  return { raw: db, prepare: (sql) => statement(sql), batch: async (statements) => { for (const item of statements) await item.run() } }
}

test('listening history pages through every play, newest first', async () => {
  const env = { TOMIFY_DB: d1() }
  const insert = env.TOMIFY_DB.raw.prepare('INSERT INTO listening_events (username, track_id, title, listened_seconds, completed, skipped, played_at) VALUES (?, ?, ?, 100, ?, ?, ?)')
  insert.run('tom', 't1', 'One', 1, 0, 1000)
  insert.run('tom', 't2', 'Two', 0, 1, 3000)
  insert.run('tom', 't3', 'Three', 1, 0, 2000)
  insert.run('tom', 't4', 'Same time', 1, 0, 2000)
  insert.run('anna', 'x', 'Not mine', 1, 0, 5000)
  const first = await listeningHistory(env, 'tom', null, 2)
  assert.deepEqual(first.events.map((event) => event.trackId), ['t2', 't4'])
  assert.equal(first.events[0].skipped, true)
  assert.equal(first.events[0].completed, false)
  const second = await listeningHistory(env, 'tom', first.next, 2)
  assert.deepEqual(second.events.map((event) => event.trackId), ['t3', 't1'])
  assert.equal(second.next, null)
  assert.deepEqual((await listeningHistory(env, 'tom', 'nonsense', 10)).events.length, 4)
})

// A Navidrome stand-in: accepts any login, knows playlist p1 owned by tom, and records edits.
function navidrome() {
  const edits = []
  const fetcher = async (url, init = {}) => {
    const target = new URL(url)
    const path = target.pathname
    if (path.endsWith('/ping.view')) return Response.json({ 'subsonic-response': { status: 'ok' } })
    if (path.endsWith('/getPlaylist.view')) return Response.json({ 'subsonic-response': { status: 'ok', playlist: { id: 'p1', owner: 'tom', name: 'Road trip' } } })
    if (path.endsWith('/updatePlaylist.view') || path.endsWith('/createPlaylist.view')) {
      const form = new URLSearchParams(String(init.body))
      edits.push({ endpoint: path.split('/').pop(), user: form.get('u'), token: form.get('t'), playlistId: form.get('playlistId'), add: form.getAll('songIdToAdd'), remove: form.getAll('songIndexToRemove'), songs: form.getAll('songId') })
      return Response.json({ 'subsonic-response': form.get('t') === 'old' ? { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } : { status: 'ok' } })
    }
    throw new Error(`unexpected ${url}`)
  }
  return { edits, fetcher }
}

test('an owner can let someone edit a playlist, and their changes are made as the owner', async () => {
  const env = { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test', TOMIFY_MEDIA_KEY: 'media-key' }
  const { edits, fetcher } = navidrome()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetcher
  const call = async (user, token, method, path, body) => {
    const url = new URL(`https://tomify.example${path}`)
    const response = await handlePlaylistShareRequest(new Request(url, { method, headers: { 'x-tomify-user': user, 'x-tomify-token': token, 'x-tomify-salt': 's', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, url)
    return { status: response.status, body: await response.json() }
  }
  try {
    await call('anna', 'a', 'GET', '/api/playlist-shares')
    await call('sam', 's', 'GET', '/api/playlist-shares')
    const saved = await call('tom', 'tok', 'PUT', '/api/playlist-shares/navidrome/p1', { users: ['anna', 'sam'], editors: ['anna', 'stranger'] })
    assert.deepEqual(saved.body, { kind: 'navidrome', playlistId: 'p1', sharedWith: ['anna', 'sam'], editors: ['anna'] })
    assert.equal(env.TOMIFY_DB.raw.prepare('SELECT COUNT(*) AS count FROM playlist_owner_logins').get().count, 1)

    const annaView = await call('anna', 'a', 'GET', '/api/playlist-shares')
    assert.deepEqual(annaView.body.sharedWithMe, [{ kind: 'navidrome', playlistId: 'p1', owner: 'tom', name: 'Road trip', canEdit: true }])
    const tomView = await call('tom', 'tok', 'GET', '/api/playlist-shares')
    assert.deepEqual(tomView.body.sharedByMe, [{ kind: 'navidrome', playlistId: 'p1', sharedWith: ['anna', 'sam'], editors: ['anna'] }])

    assert.deepEqual((await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'add', songIds: ['s9'] })).body, { ok: true })
    assert.deepEqual((await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'remove', indexes: [2] })).body, { ok: true })
    assert.deepEqual((await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'replace', songIds: ['s2', 's1'] })).body, { ok: true })
    assert.deepEqual(edits.map((edit) => [edit.endpoint, edit.user, edit.token, edit.playlistId]), [['updatePlaylist.view', 'tom', 'tok', 'p1'], ['updatePlaylist.view', 'tom', 'tok', 'p1'], ['createPlaylist.view', 'tom', 'tok', 'p1']])
    assert.deepEqual([edits[0].add, edits[1].remove, edits[2].songs], [['s9'], ['2'], ['s2', 's1']])

    assert.equal((await call('sam', 's', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'add', songIds: ['s9'] })).status, 403)
    assert.equal((await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'shuffle' })).status, 400)

    // The owner's saved login stops working (password changed): editors are told to ask them to open Tomify.
    await call('tom', 'old', 'GET', '/api/playlist-shares')
    const expired = await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'add', songIds: ['s9'] })
    assert.equal(expired.status, 409)
    assert.match(expired.body.message, /Ask tom to open Tomify/)

    // Taking editing away forgets the owner's login.
    await call('tom', 'tok', 'PUT', '/api/playlist-shares/navidrome/p1', { users: ['anna'], editors: [] })
    assert.equal(env.TOMIFY_DB.raw.prepare('SELECT COUNT(*) AS count FROM playlist_owner_logins').get().count, 0)
    assert.equal((await call('anna', 'a', 'POST', '/api/playlist-shares/navidrome/p1/songs', { action: 'add', songIds: ['s9'] })).status, 403)
  } finally { globalThis.fetch = realFetch }
})

test('letting others edit needs TOMIFY_MEDIA_KEY', async () => {
  const env = { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test' }
  const realFetch = globalThis.fetch
  globalThis.fetch = navidrome().fetcher
  try {
    const call = (user, method, path, body) => { const url = new URL(`https://tomify.example${path}`); return handlePlaylistShareRequest(new Request(url, { method, headers: { 'x-tomify-user': user, 'x-tomify-token': 't', 'x-tomify-salt': 's', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, url) }
    await call('anna', 'GET', '/api/playlist-shares')
    assert.equal((await (await call('tom', 'GET', '/api/playlist-shares')).json()).collaboration, false)
    const refused = await call('tom', 'PUT', '/api/playlist-shares/navidrome/p1', { users: ['anna'], editors: ['anna'] })
    assert.equal(refused.status, 503)
    assert.equal((await call('tom', 'PUT', '/api/playlist-shares/navidrome/p1', { users: ['anna'] })).status, 200)
  } finally { globalThis.fetch = realFetch }
})
