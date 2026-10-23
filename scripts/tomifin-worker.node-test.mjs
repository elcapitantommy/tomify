import test from 'node:test'
import assert from 'node:assert/strict'
import { tomifinRoute } from '../worker/routes/tomifin.ts'

// The recovery agent (and the Jellyfin sign-in it checks) is faked here: no request leaves the test and no torrent
// is ever submitted. The fake agent accepts one session, SESSION, as a Jellyfin administrator.
const AGENT = 'https://agent.tomifin.test'
const SESSION = 'c'.repeat(32)
const resultId = 'a'.repeat(64)
const jobId = '00000000-0000-4000-8000-000000000001'
const env = { RECOVERY_AGENT_URL: AGENT, RECOVERY_AGENT_TOKEN: 'agent-secret-token-that-is-long-enough' }
const unauthorized = () => Response.json({ error: 'tomifin-error', code: 'unauthorized', message: 'Your Jellyfin session has ended. Sign in again.' }, { status: 400 })

async function withFakes({ agent = () => Response.json({}) } = {}, callback) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const calls = []
  console.log = () => {}
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.origin === AGENT) {
      const body = JSON.parse(init.body || '{}')
      calls.push({ path: url.pathname, body, authorization: init.headers?.authorization })
      if (!['/v1/tomifin/login', '/v1/tomifin/logout'].includes(url.pathname) && body.session !== SESSION) return unauthorized()
      return agent(url.pathname, body)
    }
    throw new Error(`Unexpected request to ${url}`)
  }
  try { await callback(calls) } finally { globalThis.fetch = originalFetch; console.log = originalLog }
}

function call(path, { method = 'GET', body, session = SESSION, page = true, host = 'app.tomify.test' } = {}) {
  const headers = {
    ...(page ? { 'x-tomifin': '1' } : {}),
    ...(session ? { cookie: `theme=dark; tomifin_session=${session}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  }
  const request = new Request(`https://${host}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
  return tomifinRoute(request, env, new URL(request.url))
}
// What the agent was sent, without the session (checked separately).
const sent = ({ path, body: { session, ...body }, authorization }) => ({ path, body, session, authorization })

test('Tomifin ignores other paths', async () => {
  assert.equal(await tomifinRoute(new Request('https://app.tomify.test/api/recovery'), env, new URL('https://app.tomify.test/api/recovery')), null)
  assert.equal(await tomifinRoute(new Request('https://app.tomify.test/tomifin/'), env, new URL('https://app.tomify.test/tomifin/')), null)
})

test('signing in with Jellyfin sets an HttpOnly session cookie, and signing out clears it', async () => {
  const agent = (path, body) => path === '/v1/tomifin/login'
    ? (body.password === 'right' ? Response.json({ token: SESSION, user: { name: 'tom' } }) : Response.json({ error: 'tomifin-error', code: 'invalid-login', message: 'Jellyfin did not accept that username and password.' }, { status: 400 }))
    : path === '/v1/tomifin/session' ? Response.json({ user: { name: 'tom' } }) : Response.json({ signedOut: true })
  await withFakes({ agent }, async (calls) => {
    const signedIn = await call('/api/tomifin/session', { method: 'POST', session: null, body: { username: ' tom ', password: 'right' } })
    assert.equal(signedIn.status, 200)
    assert.deepEqual(await signedIn.json(), { user: { name: 'tom' } })
    const cookie = signedIn.headers.get('set-cookie')
    assert.match(cookie, new RegExp(`^tomifin_session=${SESSION}; `))
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/tomifin']) assert.ok(cookie.includes(part), part)
    assert.deepEqual(calls[0].body, { username: 'tom', password: 'right' })

    const wrong = await call('/api/tomifin/session', { method: 'POST', session: null, body: { username: 'tom', password: 'wrong' } })
    assert.deepEqual([wrong.status, (await wrong.json()).error], [401, 'invalid-login'])
    assert.equal(wrong.headers.get('set-cookie'), null)
    assert.equal((await call('/api/tomifin/session', { method: 'POST', session: null, body: { username: '', password: 'x' } })).status, 400)
    assert.equal((await call('/api/tomifin/session', { method: 'POST', session: null, body: { username: 'tom', password: 'x'.repeat(513) } })).status, 400)

    assert.deepEqual(await (await call('/api/tomifin/session')).json(), { user: { name: 'tom' } })
    assert.equal((await call('/api/tomifin/session', { session: null })).status, 401)
    const before = calls.length
    const signedOut = await call('/api/tomifin/session', { method: 'DELETE' })
    assert.equal(signedOut.status, 200)
    assert.match(signedOut.headers.get('set-cookie'), /^tomifin_session=; .*Max-Age=0/)
    assert.deepEqual(calls.slice(before).map(({ path, body }) => [path, body.session]), [['/v1/tomifin/logout', SESSION]])
  })
})

test('Tomifin requires a Jellyfin session for every route, and drops one Jellyfin no longer accepts', async () => {
  await withFakes({}, async (calls) => {
    for (const [path, method] of [['/api/tomifin/status', 'GET'], ['/api/tomifin/search?q=Big+Buck+Bunny', 'GET'], ['/api/tomifin/download', 'POST'], ['/api/tomifin/downloads', 'GET'], [`/api/tomifin/downloads/${jobId}/cancel`, 'POST']]) {
      const body = method === 'POST' ? { resultId, destination: 'family' } : undefined
      const anonymous = await call(path, { method, body, session: null })
      assert.equal(anonymous.status, 401, path)
      const expired = await call(path, { method, body, session: 'd'.repeat(32) })
      assert.equal(expired.status, 401, path)
      assert.match(expired.headers.get('set-cookie'), /Max-Age=0/, path)
    }
    assert.equal(calls.filter(({ body }) => body.session === undefined).length, 0)
  })
  await withFakes({ agent: () => Response.json({ error: 'tomifin-error', code: 'forbidden', message: 'Only Jellyfin administrators can use Tomifin Downloader.' }, { status: 400 }) }, async () => {
    const response = await call('/api/tomifin/search?q=Big+Buck+Bunny')
    assert.equal(response.status, 403)
    assert.match((await response.json()).message, /administrators/)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
  })
})

test('changes need Tomifin\'s own request header, so another site cannot submit them', async () => {
  await withFakes({ agent: () => Response.json({ ok: true }) }, async (calls) => {
    for (const [path, body] of [['/api/tomifin/download', { resultId, destination: 'family' }], [`/api/tomifin/downloads/${jobId}/cancel`, undefined], ['/api/tomifin/session', { username: 'tom', password: 'x' }]]) {
      const response = await call(path, { method: 'POST', body, page: false })
      assert.equal(response.status, 403, path)
    }
    assert.equal((await call('/api/tomifin/session', { method: 'DELETE', page: false })).status, 403)
    assert.equal(calls.length, 0)
  })
})

test('search passes only the query and kind to the agent, and returns its results', async () => {
  const results = [{ id: resultId, title: 'Big Buck Bunny 1080p', source: 'yts.test', size: 1, seeders: 4, leechers: 1, type: 'torrent', linkType: 'magnet', quality: {} }]
  await withFakes({ agent: () => Response.json({ query: 'Big Buck Bunny', kind: 'movies', results }) }, async (calls) => {
    const response = await call('/api/tomifin/search?q=%20Big%20%20Buck%20Bunny%20&kind=movies&savePath=/etc')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).results, results)
    assert.deepEqual(calls.map(sent), [{ path: '/v1/tomifin/search', body: { query: 'Big Buck Bunny', kind: 'movies' }, session: SESSION, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN }])
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
      assert.deepEqual(sent(calls.at(-1)), { path: '/v1/tomifin/download', body: { resultId, destination }, session: SESSION, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN })
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
    jellyfin: () => Response.json({ error: 'tomifin-error', code: 'jellyfin-unavailable', message: 'Jellyfin could not be reached from the media server.' }, { status: 400 }),
  }
  const expected = { duplicate: [409, 'duplicate'], expired: [409, 'result-expired'], off: [503, 'not-configured'], qbittorrent: [502, 'agent-error'], outdated: [409, 'recovery-agent-outdated'], gateway: [502, 'agent-error'], down: [502, 'agent-unavailable'], jellyfin: [502, 'jellyfin-unavailable'] }
  for (const [name, reply] of Object.entries(replies)) {
    await withFakes({ agent: reply }, async () => {
      const response = await call('/api/tomifin/download', { method: 'POST', body: { resultId, destination: 'family' } })
      const body = await response.json()
      assert.deepEqual([response.status, body.error], expected[name], name)
      assert.equal(typeof body.message, 'string')
      assert.doesNotMatch(JSON.stringify(body), /agent-secret-token/)
      assert.equal(response.headers.get('set-cookie'), null, name)
    })
  }
})

test('downloads can be listed, paused, resumed and cancelled by id only', async () => {
  await withFakes({ agent: (path) => Response.json(path === '/v1/tomifin/downloads' ? { jobs: [{ id: jobId, status: 'downloading', progress: 12.5 }] } : { ok: true }) }, async (calls) => {
    assert.equal((await (await call('/api/tomifin/downloads')).json()).jobs[0].progress, 12.5)
    for (const action of ['pause', 'resume', 'cancel']) {
      assert.equal((await call(`/api/tomifin/downloads/${jobId}/${action}`, { method: 'POST' })).status, 200)
      assert.deepEqual(sent(calls.at(-1)), { path: `/v1/tomifin/${action}`, body: { id: jobId }, session: SESSION, authorization: 'Bearer ' + env.RECOVERY_AGENT_TOKEN })
    }
    const before = calls.length
    for (const path of ['/api/tomifin/downloads/..%2F..%2Fetc/cancel', '/api/tomifin/downloads/not-a-job/pause', `/api/tomifin/downloads/${jobId}/delete`]) {
      assert.equal((await call(path, { method: 'POST' })).status, 404, path)
    }
    assert.equal((await call(`/api/tomifin/downloads/${jobId}/cancel`)).status, 404, 'GET does not cancel')
    assert.equal(calls.length, before)
  })
})

test('Tomifin says so when the recovery agent is not configured', async () => {
  await withFakes({}, async (calls) => {
    const request = new Request('https://app.tomify.test/api/tomifin/session', { headers: { cookie: `tomifin_session=${SESSION}` } })
    const response = await tomifinRoute(request, {}, new URL(request.url))
    assert.deepEqual([response.status, (await response.json()).error], [503, 'not-configured'])
    assert.equal(calls.length, 0)
  })
})

// Tomifin's own address, served by the same Worker.
const { tomifinSiteRoute } = await import('../worker/routes/tomifin-site.ts')
const HOST = 'tomifin.tomdixon.uk'
const PAGE = '<!doctype html><title>Tomifin Downloader</title>'
function assets() {
  const paths = []
  return { paths, fetch: async (request) => { const path = new URL(request.url).pathname; paths.push(path); return new Response(path === '/tomifin/' ? PAGE : `asset ${path}`, { headers: { 'content-type': path === '/tomifin/' ? 'text/html' : 'application/octet-stream' } }) } }
}
function site(url, init = {}, extra = {}) {
  const request = new Request(url, init)
  return tomifinSiteRoute(request, { ...env, TOMIFIN_HOSTNAME: HOST, ...extra }, new URL(request.url))
}

test('Tomifin\'s address serves its page for every route, with no caching or framing', async () => {
  const binding = assets()
  for (const path of ['/', '/downloads', '/some/deep/link', '/index.html']) {
    const response = await site(`https://${HOST}${path}`, {}, { ASSETS: binding })
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), PAGE, path)
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('x-robots-tag'), /noindex/)
  }
  assert.ok(binding.paths.every((path) => path === '/tomifin/'))
  assert.equal(await (await site(`https://${HOST}/assets/tomifin-abc.js`, {}, { ASSETS: binding })).text(), 'asset /assets/tomifin-abc.js')
  assert.equal(await (await site(`https://${HOST}/tomify-logo-192.png`, {}, { ASSETS: binding })).text(), 'asset /tomify-logo-192.png')
})

test('Tomifin\'s address serves none of Tomify: other APIs, the service worker and or the Navidrome proxy', async () => {
  const binding = assets()
  for (const path of ['/api/recovery', '/api/version', '/api/system/reboot']) {
    const response = await site(`https://${HOST}${path}`, {}, { ASSETS: binding })
    assert.equal(response.status, 404, path)
    assert.deepEqual(await response.json(), { error: 'not-found' })
  }
  for (const path of ['/sw.js', '/push-sw.js', '/manifest.webmanifest', '/server/index.js']) assert.equal((await site(`https://${HOST}${path}`, {}, { ASSETS: binding })).status, 404, path)
  for (const path of ['/navidrome/rest/stream.view', '/navidrome/rest/getPlaylists.view', '/navidrome/app/']) assert.equal((await site(`https://${HOST}${path}`)).status, 404, path)
  assert.equal((await site(`https://${HOST}/navidrome/rest/ping.view?mt=token`)).status, 404)
  assert.equal((await site(`https://${HOST}/`, { method: 'POST' }, { ASSETS: binding })).status, 405)
  assert.deepEqual(binding.paths, [])
})

test('Tomifin\'s address answers its API with the Jellyfin session cookie', async () => {
  await withFakes({ agent: () => Response.json({ available: true, destinations: [] }) }, async (calls) => {
    const status = await site(`https://${HOST}/api/tomifin/status`, { headers: { cookie: `tomifin_session=${SESSION}` } })
    assert.equal(status.status, 200)
    assert.deepEqual(sent(calls[0]).path, '/v1/tomifin/status')
    assert.equal(calls[0].body.session, SESSION)
    assert.equal((await site(`https://${HOST}/api/tomifin/status`)).status, 401)
  })
})

test('Tomify\'s address no longer serves Tomifin, and without TOMIFIN_HOSTNAME nothing changes', async () => {
  const moved = await site('https://app.tomify.tomdixon.uk/tomifin/')
  assert.equal(moved.status, 301)
  assert.equal(moved.headers.get('location'), `https://${HOST}/`)
  assert.equal((await site('https://app.tomify.tomdixon.uk/api/tomifin/status')).status, 404)
  assert.equal(await site('https://app.tomify.tomdixon.uk/albums/1'), null)
  assert.equal(await site('https://app.tomify.tomdixon.uk/api/recovery'), null)
  assert.equal(await site('https://app.tomify.tomdixon.uk/tomifinder'), null)
  assert.equal(await site(`https://${HOST}/`, {}, { TOMIFIN_HOSTNAME: '' }), null)
})
