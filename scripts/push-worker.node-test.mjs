import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { base64Url, encryptPayload, fromBase64Url, generateVapidKeys, sendPush } from '../worker/lib/web-push.ts'
import { checkRecoveryJobs, handlePushRequest, notify, notifyNewReleases, vapidKeys } from '../worker/features/push.ts'

function d1() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'))
  const statement = (sql, values = []) => ({ bind: (...next) => statement(sql, next), first: async () => db.prepare(sql).get(...values) ?? null, all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }) })
  return { raw: db, prepare: (sql) => statement(sql), batch: async (statements) => { for (const item of statements) await item.run() } }
}

// A browser's side of a subscription: its ECDH key pair and auth secret.
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { pair, p256dh: base64Url(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: base64Url(auth) }
}

// RFC 8291 decryption, as the browser does it.
async function decrypt(client, body) {
  const salt = body.slice(0, 16)
  const keyLength = body[20]
  const serverKey = body.slice(21, 21 + keyLength)
  const server = await crypto.subtle.importKey('raw', serverKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: server }, client.pair.privateKey, 256))
  const hkdf = async (saltBytes, secret, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info }, await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']), bytes * 8))
  const text = (value) => new TextEncoder().encode(value)
  const ikm = await hkdf(fromBase64Url(client.auth), shared, new Uint8Array([...text('WebPush: info\0'), ...fromBase64Url(client.p256dh), ...serverKey]), 32)
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12)
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(21 + keyLength)))
  assert.equal(plain[plain.length - 1], 2, 'last record delimiter')
  return { text: new TextDecoder().decode(plain.slice(0, -1)), recordSize: new DataView(body.buffer, body.byteOffset).getUint32(16) }
}

function pushService() {
  const sent = []
  const fetcher = async (url, init) => { sent.push({ url, init, body: new Uint8Array(init.body) }); return new Response(null, { status: url.includes('gone') ? 410 : 201 }) }
  return { sent, fetcher }
}

test('a message is encrypted so only the subscribed browser can read it', async () => {
  const client = await browser()
  const body = await encryptPayload(client, JSON.stringify({ title: 'Hello' }))
  assert.deepEqual(await decrypt(client, body), { text: '{"title":"Hello"}', recordSize: 4096 })
})

test('each message is signed with the VAPID key the browser subscribed with', async () => {
  const keys = await generateVapidKeys('https://tomify.example')
  const client = await browser()
  const { sent, fetcher } = pushService()
  assert.equal(await sendPush(keys, { endpoint: 'https://push.example/send/abc', ...client }, 'hi', Date.parse('2026-10-21T08:00:00Z'), fetcher), 201)
  const { headers } = sent[0].init
  assert.equal(headers['content-encoding'], 'aes128gcm')
  const [, token, key] = headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/)
  assert.equal(key, keys.publicKey)
  const [header, claims, signature] = token.split('.')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(claims))), { aud: 'https://push.example', exp: Math.floor(Date.parse('2026-10-21T08:00:00Z') / 1000) + 43200, sub: 'https://tomify.example' })
  const publicKey = await crypto.subtle.importKey('raw', fromBase64Url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64Url(signature), new TextEncoder().encode(`${header}.${claims}`)))
  assert.equal((await decrypt(client, sent[0].body)).text, 'hi')
})

test('the key pair is made once and kept', async () => {
  const env = { TOMIFY_DB: d1() }
  assert.equal(await vapidKeys(env), null)
  const first = await vapidKeys(env, 'https://tomify.example')
  const second = await vapidKeys(env, 'https://other.example')
  assert.deepEqual(second, first)
  assert.equal(first.subject, 'https://tomify.example')
})

test('messages go only to subscriptions for that topic, and gone ones are removed', async () => {
  const env = { TOMIFY_DB: d1() }
  await vapidKeys(env, 'https://tomify.example')
  const client = await browser()
  const add = (endpoint, username, topics) => env.TOMIFY_DB.raw.prepare('INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, topics, created_at) VALUES (?, ?, ?, ?, ?, 1)').run(endpoint, username, client.p256dh, client.auth, topics)
  add('https://push.example/tom', 'tom', 'recovery,new-releases')
  add('https://push.example/anna', 'anna', 'new-releases')
  add('https://push.example/gone', 'sam', 'new-releases')
  const { sent, fetcher } = pushService()
  assert.equal(await notify(env, 'recovery', { title: 'x', body: 'y', url: '/' }, undefined, fetcher), 1)
  assert.deepEqual(sent.map((item) => item.url), ['https://push.example/tom'])
  assert.equal(await notify(env, 'new-releases', { title: 'x', body: 'y', url: '/' }, 'anna', fetcher), 1)
  assert.equal(await notify(env, 'new-releases', { title: 'x', body: 'y', url: '/' }, undefined, fetcher), 2)
  assert.equal(env.TOMIFY_DB.raw.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE endpoint LIKE '%gone'").get().count, 0)
})

test('new releases are announced once, listing only recent or announced ones', async () => {
  const env = { TOMIFY_DB: d1() }
  await vapidKeys(env, 'https://tomify.example')
  const client = await browser()
  env.TOMIFY_DB.raw.prepare('INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, topics, created_at) VALUES (?, ?, ?, ?, ?, 1)').run('https://push.example/tom', 'tom', client.p256dh, client.auth, 'new-releases')
  const found = Date.parse('2026-10-21T04:30:00Z')
  const release = env.TOMIFY_DB.raw.prepare('INSERT INTO new_releases (release_group_id, artist_key, artist_name, title, release_type, release_date, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  release.run('g1', 'muse', 'Muse', 'New Album', 'Album', '2026-10-18', found)
  release.run('g2', 'muse', 'Muse', 'Old Single', 'Single', '2026-03-01', found)
  release.run('g3', 'ash', 'Ash', 'Coming Soon', 'Album', '2026-12-01', found)
  release.run('g4', 'ash', 'Ash', 'Found Yesterday', 'Album', '2026-10-19', found - 86_400_000)
  const { sent, fetcher } = pushService()
  assert.equal(await notifyNewReleases(env, found, fetcher), 1)
  const message = JSON.parse((await decrypt(client, sent[0].body)).text)
  assert.equal(message.title, '2 new releases from your artists')
  assert.match(message.body, /Ash – Coming Soon/)
  assert.match(message.body, /Muse – New Album/)
  assert.doesNotMatch(message.body, /Old Single|Found Yesterday/)
  assert.equal(await notifyNewReleases(env, found + 1, fetcher), 0)
})

test('a finished Recovery download is announced once, to its owner', async () => {
  const env = { TOMIFY_DB: d1(), RECOVERY_AGENT_URL: 'https://agent.example' }
  await vapidKeys(env, 'https://tomify.example')
  const client = await browser()
  const db = env.TOMIFY_DB.raw
  db.prepare('INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, topics, created_at) VALUES (?, ?, ?, ?, ?, 1)').run('https://push.example/tom', 'tom', client.p256dh, client.auth, 'recovery')
  const item = (id, status, jobId) => {
    db.prepare("INSERT INTO recovery_items (id, username, artist, title, album, status) VALUES (?, 'tom', 'Muse', '', 'Wow! Signal', ?)").run(id, status)
    db.prepare("INSERT INTO recovery_candidates (id, recovery_id, backend, external_id, url, title, channel, selected, provenance_json) VALUES (?, ?, 'usenet', ?, '', 'x', '', 1, ?)").run(`c-${id}`, id, `e-${id}`, JSON.stringify({ job: { id: jobId } }))
  }
  item('r1', 'downloading', 'job-done')
  item('r2', 'downloading', 'job-busy')
  item('r3', 'recovered', 'job-old')
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const { jobId } = JSON.parse(init.body)
    asked.push(jobId)
    return new Response(JSON.stringify({ job: { status: jobId === 'job-done' ? 'completed' : 'downloading' } }))
  }
  try {
    const { sent, fetcher } = pushService()
    assert.equal(await checkRecoveryJobs(env, fetcher), 1)
    assert.deepEqual(asked.sort(), ['job-busy', 'job-done'])
    const message = JSON.parse((await decrypt(client, sent[0].body)).text)
    assert.deepEqual(message, { title: 'Recovery finished', body: 'Muse – Wow! Signal is in your library.', url: '/recovery', tag: 'recovery-job-done' })
    assert.equal(await checkRecoveryJobs(env, fetcher), 0)
    assert.equal(sent.length, 1)
  } finally { globalThis.fetch = realFetch }
})

test('nobody asked: the five-minute check does not call the agent', async () => {
  const env = { TOMIFY_DB: d1(), RECOVERY_AGENT_URL: 'https://agent.example' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('should not be called') }
  try { assert.equal(await checkRecoveryJobs(env), 0) } finally { globalThis.fetch = realFetch }
})

test('subscribing keeps only allowed topics, and Recovery only for administrators', async () => {
  const env = { TOMIFY_DB: d1(), NAVIDROME_ORIGIN: 'https://navidrome.test' }
  const realFetch = globalThis.fetch
  let admin = false
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/ping.view')) return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok' } }))
    if (path.endsWith('/getUser.view')) return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', user: { adminRole: admin } } }))
    throw new Error(`unexpected ${url}`)
  }
  const call = (method, path, body) => handlePushRequest(new Request(`https://tomify.example${path}`, { method, headers: { 'x-tomify-user': 'Anna', 'x-tomify-token': 't', 'x-tomify-salt': 's', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, new URL(`https://tomify.example${path}`))
  try {
    const state = await (await call('GET', '/api/push')).json()
    assert.equal(state.topics, null)
    assert.equal(fromBase64Url(state.publicKey).length, 65)
    const subscription = { endpoint: 'https://push.example/anna', keys: { p256dh: 'p', auth: 'a' } }
    assert.deepEqual(await (await call('PUT', '/api/push/subscription', { subscription, topics: ['recovery', 'new-releases', 'spam'] })).json(), { topics: ['new-releases'] })
    admin = true
    assert.deepEqual(await (await call('PUT', '/api/push/subscription', { subscription, topics: ['recovery', 'new-releases'] })).json(), { topics: ['recovery', 'new-releases'] })
    assert.deepEqual((await (await call('GET', `/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`)).json()).topics, ['recovery', 'new-releases'])
    assert.equal(env.TOMIFY_DB.raw.prepare('SELECT username FROM push_subscriptions').get().username, 'anna')
    await call('PUT', '/api/push/subscription', { subscription, topics: [] })
    assert.equal(env.TOMIFY_DB.raw.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 0)
    assert.equal((await call('PUT', '/api/push/subscription', { subscription: { endpoint: 'http://insecure' }, topics: ['new-releases'] })).status, 400)
  } finally { globalThis.fetch = realFetch }
})
