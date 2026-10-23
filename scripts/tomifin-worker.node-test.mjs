import test from 'node:test'
import assert from 'node:assert/strict'
import { tomifinRoute } from '../worker/routes/tomifin.ts'

// The recovery agent and Navidrome are faked here: no request leaves the test and no torrent is ever submitted.
const NAVIDROME = 'https://navidrome.test'
const AGENT = 'https://agent.tomifin.test'
const resultId = 'a'.repeat(64)
const jobId = '00000000-0000-4000-8000-000000000001'
const env = { NAVIDROME_ORIGIN: NAVIDROME, RECOVERY_AGENT_URL: AGENT, RECOVERY_AGENT_TOKEN: 'agent-secret-token-that-is-long-enough' }
let users = 0

async function withFakes({ admin = true, agent = () => Response.json({}) } = {}, callback) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const calls = []
  console.log = () => {}
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.origin === NAVIDROME) {
      if (url.pathname === '/rest/ping.view') return Response.json({ 'subsonic-response': { status: url.searchParams.get('t') === 'good' ? 'ok' : 'failed' } })
      if (url.pathname === '/rest/getUser.view') return Response.json({ 'subsonic-response': { status: 'ok', user: { adminRole: admin } } })
    }
    if (url.origin === AGENT) {
      const body = JSON.parse(init.body || '{}')
      calls.push({ path: url.pathname, body, authorization: init.headers?.authorization })
      return agent(url.pathname, body)
    }
    throw new Error(`Unexpected request to ${url}`)
  }
  try { await callback(calls) } finally { globalThis.fetch = originalFetch; console.log = originalLog }
}

// A fresh user each call, so the 30-second sign-in cache never carries over between tests.
function call(path, { method = 'GET', body, token = 'good' } = {}) {
  users += 1
  const headers = { 'x-tomify-user': `tom${users}`, 'x-tomify-token': token, 'x-tomify-salt': 'salt', ...(body ? { 'content-type': 'application/json' } : {}) }
  const request = new Request(`https://app.tomify.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
  return tomifinRoute(request, env, new URL(request.url))
}

test('Tomifin ignores other paths', async () => {
  assert.equal(await tomifinRoute(new Request('https://app.tomify.test/api/recovery'), env, new URL('https://app.tomify.test/api/recovery')), null)
  assert.equal(await tomifinRoute(new Request('https://app.tomify.test/tomifin/'), env, new URL('https://app.tomify.test/tomifin/')), null)
})

test('Tomifin requires a signed-in Navidrome administrator for every route', async () => {
  await withFakes({}, async (calls) => {
    for (const [path, method] of [['/api/tomifin/status', 'GET'], ['/api/tomifin/search?q=Big+Buck+Bunny', 'GET'], ['/api/tomifin/download', 'POST'], ['/api/tomifin/downloads', 'GET'], [`/api/tomifin/downloads/${jobId}/cancel`, 'POST']]) {
      const response = await call(path, { method, token: 'bad', body: method === 'POST' ? { resultId, destination: 'family' } : undefined })
      assert.equal(response.status, 401, path)
      const anonymous = await tomifinRoute(new Request(`https://app.tomify.test${path}`, { method }), env, new URL(`https://app.tomify.test${path}`))
      assert.equal(anonymous.status, 401, path)
    }
    assert.equal(calls.length, 0)
  })
  await withFakes({ admin: false }, async (calls) => {
    const response = await call('/api/tomifin/search?q=Big+Buck+Bunny')
    assert.equal(response.status, 403)
    assert.match((await response.json()).message, /administrator/)
    assert.equal(calls.length, 0)
  })
})

test('search passes only the query and kind to the agent, and returns its results', async () => {
  const results = [{ id: resultId, title: 'Big Buck Bunny 1080p', source: 'yts.test', size: 1, seeders: 4, leechers: 1, type: 'torrent', linkType: 'magnet', quality: {} }]
  await withFakes({ agent: () => Response.json({ query: 'Big Buck Bunny', kind: 'movies', results }) }, async (calls) => {
    const response = await call('/api/tomifin/search?q=%20Big%20%20Buck%20Bunny%20&kind=movies&savePath=/etc')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).results, results)
    assert.deepEqual(calls, [{ path: '/v1/tomifin/search', body: { query: 'Big Buck Bunny', kind: 'movies' }, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN }])
    assert.equal((await call('/api/tomifin/search?q=x')).status, 400)
    assert.equal((await call('/api/tomifin/search?q=' + 'x'.repeat(201))).status, 400)
    assert.equal((await call('/api/tomifin/search?q=Bunny&kind=music')).status, 400)
    assert.equal(calls.length, 1)
  })
})

test('a download needs Family or Private and a search result id, and nothing else reaches the agent', async () => {
  await withFakes({ agent: (_path, body) => Response.json({ job: { id: jobId, destination: body.destination, status: 'queued' } }, { status: 202 }) }, async (calls) => {
    for (const destination of [undefined, '', 'public', '/media/family', '/media/private', '../private', 'Family']) {
      const response = await call('/api/tomifin/download', { method: 'POST', body: { resultId, destination } })
      assert.equal(response.status, 400, String(destination))
      assert.equal((await response.json()).error, 'invalid-destination')
    }
    for (const bad of [undefined, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', 'http://127.0.0.1:8081/api/v2/app/shutdown', 'A'.repeat(64)]) {
      const response = await call('/api/tomifin/download', { method: 'POST', body: { resultId: bad, destination: 'family' } })
      assert.equal((await response.json()).error, 'invalid-result', String(bad))
    }
    assert.equal((await call('/api/tomifin/download', { method: 'POST', body: 'not json' })).status, 400)
    assert.equal(calls.length, 0)

    for (const destination of ['family', 'private']) {
      const response = await call('/api/tomifin/download', { method: 'POST', body: { resultId, destination, savePath: '/etc', link: 'magnet:?xt=urn:btih:x', category: 'tomify' } })
      assert.equal(response.status, 202)
      assert.equal((await response.json()).job.destination, destination)
      assert.deepEqual(calls.at(-1), { path: '/v1/tomifin/download', body: { resultId, destination }, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN })
    }
  })
})

test('agent refusals become clear errors, and an older agent asks for an update', async () => {
  const replies = {
    duplicate: () => Response.json({ error: 'tomifin-error', code: 'duplicate', message: 'This torrent is already in qBittorrent.' }, { status: 400 }),
    expired: () => Response.json({ error: 'tomifin-error', code: 'result-expired', message: 'That search result has expired.' }, { status: 400 }),
    off: () => Response.json({ error: 'tomifin-error', code: 'not-configured', message: 'Set TOMIFY_TOMIFIN_FAMILY_DIR.' }, { status: 400 }),
    qbittorrent: () => Response.json({ error: 'recovery-agent-error', message: 'qBittorrent add returned HTTP 500.' }, { status: 400 }),
    outdated: () => Response.json({ error: 'not-found' }, { status: 404 }),
    gateway: () => new Response('Bad gateway', { status: 502 }),
    down: () => { throw new TypeError('fetch failed') },
  }
  const expected = { duplicate: [409, 'duplicate'], expired: [409, 'result-expired'], off: [503, 'not-configured'], qbittorrent: [502, 'agent-error'], outdated: [409, 'recovery-agent-outdated'], gateway: [502, 'agent-error'], down: [502, 'agent-unavailable'] }
  for (const [name, reply] of Object.entries(replies)) {
    await withFakes({ agent: reply }, async () => {
      const response = await call('/api/tomifin/download', { method: 'POST', body: { resultId, destination: 'family' } })
      const body = await response.json()
      assert.deepEqual([response.status, body.error], expected[name], name)
      assert.equal(typeof body.message, 'string')
      assert.doesNotMatch(JSON.stringify(body), /agent-secret-token/)
    })
  }
})

test('downloads can be listed, paused, resumed and cancelled by id only', async () => {
  await withFakes({ agent: (path) => Response.json(path === '/v1/tomifin/downloads' ? { jobs: [{ id: jobId, status: 'downloading', progress: 12.5 }] } : { ok: true }) }, async (calls) => {
    assert.equal((await (await call('/api/tomifin/downloads')).json()).jobs[0].progress, 12.5)
    for (const action of ['pause', 'resume', 'cancel']) {
      assert.equal((await call(`/api/tomifin/downloads/${jobId}/${action}`, { method: 'POST' })).status, 200)
      assert.deepEqual(calls.at(-1), { path: `/v1/tomifin/${action}`, body: { id: jobId }, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN })
    }
    const before = calls.length
    for (const path of ['/api/tomifin/downloads/..%2F..%2Fetc/cancel', '/api/tomifin/downloads/not-a-job/pause', `/api/tomifin/downloads/${jobId}/delete`]) {
      assert.equal((await call(path, { method: 'POST' })).status, 404, path)
    }
    assert.equal((await call(`/api/tomifin/downloads/${jobId}/cancel`)).status, 404, 'GET does not cancel')
    assert.equal(calls.length, before)
  })
})

test('status reports Tomifin off when the recovery agent is not configured', async () => {
  await withFakes({}, async (calls) => {
    const request = new Request('https://app.tomify.test/api/tomifin/status', { headers: { 'x-tomify-user': 'status-user', 'x-tomify-token': 'good', 'x-tomify-salt': 'salt' } })
    const response = await tomifinRoute(request, { NAVIDROME_ORIGIN: NAVIDROME }, new URL(request.url))
    const body = await response.json()
    assert.equal(body.available, false)
    assert.deepEqual(body.destinations.map(({ id }) => id), ['family', 'private'])
    assert.equal(calls.length, 0)
  })
})
