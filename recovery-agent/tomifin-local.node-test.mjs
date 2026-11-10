import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COOKIE, DEFAULT_LOCAL_ORIGIN, createLoginLimiter, createTomifinLocalHandler, openSession, sealSession, startTomifinLocalServer, tomifinLocalConfig } from './tomifin-local.mjs'

const SECRET = 'a'.repeat(64)
const ORIGIN = DEFAULT_LOCAL_ORIGIN
const TOKEN = 'jellyfintoken0123456789abcdef'

function webDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tomifin-web-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Tomifin</title>')
  writeFileSync(join(dir, 'assets', 'tomifin-abc.js'), 'console.log(1)')
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>')
  // A file next to the page folder, which no path may reach.
  writeFileSync(join(dir, '..', 'tomifin-outside.txt'), 'outside')
  return dir
}

// A stand-in for handleTomifinRequest: Tom is an administrator with password "right", Ann is not.
function fakeHandle(calls) {
  return async (path, body) => {
    calls.push({ path, body })
    const action = path.replace('/v1/tomifin/', '')
    if (action === 'login') {
      if (body.username === 'tom' && body.password === 'right') return { status: 200, body: { token: TOKEN, user: { name: 'tom' } } }
      if (body.username === 'ann' && body.password === 'right') return { status: 400, body: { error: 'tomifin-error', code: 'forbidden', message: 'Only Jellyfin administrators can use Tomifin Downloader.' } }
      return { status: 400, body: { error: 'tomifin-error', code: 'invalid-login', message: 'Jellyfin did not accept that username and password.' } }
    }
    if (action === 'logout') return { status: 200, body: { signedOut: true } }
    if (body.session !== TOKEN) return { status: 400, body: { error: 'tomifin-error', code: 'unauthorized', message: 'Your Jellyfin session has ended.' } }
    if (action === 'session') return { status: 200, body: { user: { name: 'tom' } } }
    if (action === 'downloads') return { status: 200, body: { jobs: [] } }
    if (action === 'download') return { status: 202, body: { job: { id: 'x' } } }
    if (action === 'status') throw new Error('qBittorrent refused secret-cookie-path')
    if (action === 'retry') return { status: 400, body: { error: 'tomifin-error', code: 'not-retryable', message: 'That download cannot be retried.' } }
    return { status: 200, body: { ok: action } }
  }
}

async function start({ now = () => Date.now(), handle } = {}) {
  const calls = []
  const logs = []
  const config = { ...tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET, TOMIFY_TOMIFIN_WEB_DIR: webDir() }), port: 0 }
  const handler = createTomifinLocalHandler({ config, handle: handle || fakeHandle(calls), now, log: (line) => logs.push(line), cleanMessage: (message) => message.replace('secret-cookie-path', '[removed]') })
  const server = await startTomifinLocalServer(config, handler)
  const { address, port } = server.address()
  const base = `http://${address}:${port}`
  const fetchLocal = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init })
  const post = (path, body, { cookie, origin = ORIGIN, header = true, method = 'POST' } = {}) => fetchLocal(path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(header ? { 'x-tomifin': '1' } : {}), ...(cookie ? { cookie } : {}) },
  })
  const signIn = async () => {
    const response = await post('/api/tomifin/session', { username: 'tom', password: 'right' })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  return { server, base, address, calls, logs, fetchLocal, post, signIn, close: () => new Promise((done) => server.close(done)) }
}

test('the listener is off unless a port is set, and refuses weak or reused secrets and odd origins', () => {
  assert.deepEqual([tomifinLocalConfig({}).enabled, tomifinLocalConfig({}).problem], [false, null])
  assert.match(tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: 'eighty' }).problem, /port number/)
  assert.match(tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: 'short' }).problem, /32 random bytes/)
  assert.match(tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET }, { recoveryToken: SECRET }).problem, /not be the Recovery token/)
  assert.match(tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET, TOMIFY_TOMIFIN_LOCAL_ORIGIN: 'http://down.tn.tomdixon.uk' }).problem, /https origin/)
  assert.match(tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET, TOMIFY_TOMIFIN_LOCAL_ORIGIN: 'https://down.tn.tomdixon.uk/app' }).problem, /no path/)
  const config = tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET }, { defaultWebDir: '/opt/tomify/current/tomifin-web' })
  assert.deepEqual([config.enabled, config.host, config.port, config.origin, config.webDir], [true, '127.0.0.1', 8790, 'https://down.tn.tomdixon.uk', '/opt/tomify/current/tomifin-web'])
})

test('a sealed session opens only with its secret, unchanged, and reports when it has expired', () => {
  const sealed = sealSession(SECRET, TOKEN, 2_000)
  assert.deepEqual(openSession(SECRET, sealed, 1_000), { token: TOKEN, expiresAt: 2_000, expired: false })
  assert.equal(openSession(SECRET, sealed, 3_000).expired, true)
  assert.equal(openSession('b'.repeat(64), sealed, 1_000), null)
  assert.equal(openSession(SECRET, sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA'), 1_000), null)
  assert.equal(openSession(SECRET, TOKEN, 1_000), null)
  assert.equal(openSession(SECRET, '', 1_000), null)
  assert.doesNotMatch(sealed, new RegExp(TOKEN))
})

test('it listens on 127.0.0.1 only', async () => {
  const local = await start()
  try { assert.equal(local.address, '127.0.0.1') } finally { await local.close() }
})

test('every API call without a valid session gets 401 with no detail', async () => {
  const local = await start()
  try {
    for (const path of ['/api/tomifin/session', '/api/tomifin/status', '/api/tomifin/downloads', '/api/tomifin/search?q=abc', '/api/tomifin/anything']) {
      const response = await local.fetchLocal(path)
      assert.equal(response.status, 401, path)
      assert.deepEqual(await response.json(), { error: 'unauthorized' })
    }
    const forged = await local.fetchLocal('/api/tomifin/downloads', { headers: { cookie: `${COOKIE}=${TOKEN}` } })
    assert.equal(forged.status, 401)
    const posted = await local.post('/api/tomifin/download', { resultId: 'a'.repeat(64), destination: 'family' })
    assert.equal(posted.status, 401)
    assert.equal(local.calls.length, 0, 'nothing reaches the Tomifin handlers')
  } finally { await local.close() }
})

test('a Jellyfin administrator signs in and gets a sealed, host-only, 12-hour cookie that the API accepts', async () => {
  const local = await start()
  try {
    const response = await local.post('/api/tomifin/session', { username: 'tom', password: 'right' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { user: { name: 'tom' } })
    const cookie = response.headers.get('set-cookie')
    assert.match(cookie, /^tomifin_session=[^;]+; Path=\/api\/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/)
    assert.doesNotMatch(cookie, /Domain=/i)
    assert.doesNotMatch(cookie, new RegExp(TOKEN))
    const session = cookie.split(';')[0]
    const list = await local.fetchLocal('/api/tomifin/downloads', { headers: { cookie: session } })
    assert.equal(list.status, 200)
    assert.deepEqual(await list.json(), { jobs: [] })
    assert.deepEqual(local.calls.at(-1), { path: '/v1/tomifin/downloads', body: { session: TOKEN } })
    const again = await local.fetchLocal('/api/tomifin/session', { headers: { cookie: session } })
    assert.deepEqual(await again.json(), { user: { name: 'tom' } })
    const queued = await local.post('/api/tomifin/download', { resultId: 'a'.repeat(64), destination: 'family' }, { cookie: session })
    assert.equal(queued.status, 202)
    assert.ok(local.logs.includes('Tomifin: tom signed in'))
    assert.ok(local.logs.every((line) => !line.includes(TOKEN) && !line.includes('right')))
  } finally { await local.close() }
})

test('a non-administrator and a wrong password are refused, and repeated failures are rate-limited', async () => {
  const local = await start()
  try {
    const ann = await local.post('/api/tomifin/session', { username: 'ann', password: 'right' })
    assert.equal(ann.status, 403)
    assert.equal(ann.headers.get('set-cookie'), 'tomifin_session=; Path=/api/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=0')
    const wrong = await local.post('/api/tomifin/session', { username: 'tom', password: 'wrong' })
    assert.equal(wrong.status, 401)
    assert.equal((await wrong.json()).error, 'invalid-login')
    for (let attempt = 0; attempt < 3; attempt += 1) await local.post('/api/tomifin/session', { username: 'tom', password: 'wrong' })
    const blocked = await local.post('/api/tomifin/session', { username: 'tom', password: 'right' })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '60')
    assert.equal(local.calls.filter((call) => call.path === '/v1/tomifin/login').length, 5)
  } finally { await local.close() }
})

test('the limiter counts failures per client for one minute', () => {
  let now = 0
  const limiter = createLoginLimiter({ now: () => now })
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.failed('100.64.0.2')
  assert.equal(limiter.blocked('100.64.0.2'), true)
  assert.equal(limiter.blocked('100.64.0.3'), false)
  now = 60_001
  assert.equal(limiter.blocked('100.64.0.2'), false)
})

test('changes need the page\'s own Origin and the x-tomifin header', async () => {
  const local = await start()
  try {
    const session = await local.signIn()
    const body = { resultId: 'a'.repeat(64), destination: 'family' }
    for (const options of [{ origin: null }, { origin: 'https://evil.example' }, { origin: 'https://tomifin.tomdixon.uk' }, { header: false }]) {
      const response = await local.post('/api/tomifin/download', body, { cookie: session, ...options })
      assert.equal(response.status, 403, JSON.stringify(options))
    }
    const signIn = await local.post('/api/tomifin/session', { username: 'tom', password: 'right' }, { origin: 'https://evil.example' })
    assert.equal(signIn.status, 403)
    assert.equal(local.calls.filter((call) => call.path === '/v1/tomifin/download').length, 0)
  } finally { await local.close() }
})

test('Tomifin errors keep their status, a session Jellyfin dropped clears the cookie, and other errors are cleaned', async () => {
  const local = await start()
  try {
    const session = await local.signIn()
    const retry = await local.post('/api/tomifin/downloads/00000000-0000-4000-8000-000000000000/retry', undefined, { cookie: session })
    assert.equal(retry.status, 409)
    assert.equal((await retry.json()).error, 'not-retryable')
    const status = await local.fetchLocal('/api/tomifin/status', { headers: { cookie: session } })
    assert.equal(status.status, 502)
    assert.deepEqual(await status.json(), { error: 'agent-error', message: 'qBittorrent refused [removed]' })
    const bad = await local.fetchLocal('/api/tomifin/search?q=a', { headers: { cookie: session } })
    assert.equal(bad.status, 400)
  } finally { await local.close() }

  const dropped = await start({ handle: async (path, body) => path.endsWith('/login') ? { status: 200, body: { token: TOKEN, user: { name: 'tom' } } } : { status: 400, body: { error: 'tomifin-error', code: 'unauthorized', message: 'Your Jellyfin session has ended.', session: body.session } } })
  try {
    const session = await dropped.signIn()
    const response = await dropped.fetchLocal('/api/tomifin/downloads', { headers: { cookie: session } })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
  } finally { await dropped.close() }
})

test('an expired session returns to sign-in and is signed out of Jellyfin; sign-out ends a session', async () => {
  let now = 1_000_000
  const local = await start({ now: () => now })
  try {
    const session = await local.signIn()
    now += 12 * 3600_000 + 1
    const expired = await local.fetchLocal('/api/tomifin/downloads', { headers: { cookie: session } })
    assert.equal(expired.status, 401)
    assert.match(expired.headers.get('set-cookie'), /Max-Age=0/)
    await new Promise((done) => setImmediate(done))
    assert.deepEqual(local.calls.at(-1), { path: '/v1/tomifin/logout', body: { session: TOKEN } })

    now = 1_000_000
    const fresh = await local.signIn()
    const out = await local.post('/api/tomifin/session', undefined, { cookie: fresh, method: 'DELETE' })
    assert.equal(out.status, 200)
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
    assert.deepEqual(local.calls.at(-1), { path: '/v1/tomifin/logout', body: { session: TOKEN } })
  } finally { await local.close() }
})

test('it serves the page with a fallback to index.html, and nothing outside the page or Tomifin', async () => {
  const local = await start()
  try {
    const page = await local.fetchLocal('/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.match(page.headers.get('content-security-policy'), /font-src 'self';/)
    assert.doesNotMatch(page.headers.get('content-security-policy'), /google|gstatic/)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.equal(page.headers.get('cache-control'), 'no-cache')
    assert.equal(await page.text(), '<!doctype html><title>Tomifin</title>')
    const deep = await local.fetchLocal('/downloads/anything')
    assert.equal(await deep.text(), '<!doctype html><title>Tomifin</title>')
    const asset = await local.fetchLocal('/assets/tomifin-abc.js')
    assert.match(asset.headers.get('content-type'), /^text\/javascript/)
    assert.match(asset.headers.get('cache-control'), /immutable/)
    assert.equal((await local.fetchLocal('/favicon.svg')).status, 200)
    assert.equal((await local.fetchLocal('/missing.js')).status, 404)
    const head = await local.fetchLocal('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal((await local.fetchLocal('/', { method: 'POST' })).status, 405)
    for (const path of ['/v1/tomifin/downloads', '/v1/status', '/v1/jobs/status', '/health', '/api/recovery/jobs', '/navidrome/rest/ping.view', '/..%2ftomifin-outside.txt', '/%2e%2e/tomifin-outside.txt', '/assets/..%2f..%2ftomifin-outside.txt']) {
      const response = await local.fetchLocal(path)
      assert.ok([400, 404].includes(response.status), `${path} answered ${response.status}`)
      assert.doesNotMatch(await response.text(), /Tomifin<\/title>|outside/)
    }
    assert.equal(local.calls.length, 0)
  } finally { await local.close() }
})

test('without the built page the listener stays off and says why', async () => {
  const logs = []
  const config = { ...tomifinLocalConfig({ TOMIFY_TOMIFIN_LOCAL_PORT: '8790', TOMIFY_TOMIFIN_SESSION_SECRET: SECRET, TOMIFY_TOMIFIN_WEB_DIR: join(tmpdir(), 'no-such-tomifin-web') }), port: 0 }
  assert.equal(await startTomifinLocalServer(config, () => {}, { log: (line) => logs.push(line) }), null)
  assert.match(logs[0], /Tomifin local listener is off: .*index\.html is missing/)
})
