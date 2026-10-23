import test from 'node:test'
import assert from 'node:assert/strict'
import { createJellyfinAuth, jellyfinConfig, JellyfinAuthError } from './jellyfin.mjs'

const admin = { Id: 'u1', Name: 'tom', Policy: { IsAdministrator: true, IsDisabled: false } }
const viewer = { Id: 'u2', Name: 'kid', Policy: { IsAdministrator: false, IsDisabled: false } }
const adminToken = 'a'.repeat(32)
const viewerToken = 'b'.repeat(32)

// A Jellyfin stand-in: records every call and never reaches a real server.
function fakeJellyfin() {
  const calls = []
  const sessions = new Map([[adminToken, admin], [viewerToken, viewer]])
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const auth = init.headers.authorization
    const token = auth.match(/Token="([^"]+)"/)?.[1] || null
    calls.push([init.method, url.pathname, token, auth])
    if (url.pathname === '/Users/AuthenticateByName') {
      const { Username, Pw } = JSON.parse(init.body)
      if (Username === 'tom' && Pw === 'right') return Response.json({ AccessToken: adminToken, User: admin })
      if (Username === 'kid' && Pw === 'right') return Response.json({ AccessToken: viewerToken, User: viewer })
      return new Response('', { status: 401 })
    }
    if (url.pathname === '/Users/Me') return sessions.has(token) ? Response.json(sessions.get(token)) : new Response('', { status: 401 })
    if (url.pathname === '/Sessions/Logout') { sessions.delete(token); return new Response(null, { status: 204 }) }
    return new Response('', { status: 404 })
  }
  return { calls, sessions, fetchImpl }
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error instanceof JellyfinAuthError && error.code === code)
}

test('jellyfinConfig accepts loopback HTTP or HTTPS and refuses anything else', () => {
  assert.equal(jellyfinConfig({}), null)
  assert.deepEqual(jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://127.0.0.1:8096/' }), { url: 'http://127.0.0.1:8096' })
  assert.deepEqual(jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'https://jellyfin.example.com' }), { url: 'https://jellyfin.example.com' })
  assert.throws(() => jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://192.168.1.5:8096' }, { localAddresses: () => ['127.0.0.1', '192.168.1.81'] }), /HTTPS/)
  // Jellyfin in Docker published on the box's own LAN address: plain HTTP stays on this machine.
  assert.deepEqual(jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://192.168.1.81:8096' }, { localAddresses: () => ['127.0.0.1', '192.168.1.81', 'fe80::1'] }), { url: 'http://192.168.1.81:8096' })
  assert.deepEqual(jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://[fe80::1]:8096' }, { localAddresses: () => ['fe80::1'] }), { url: 'http://[fe80::1]:8096' })
  assert.deepEqual(jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://localhost:8096' }), { url: 'http://localhost:8096' })
  assert.throws(() => jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'http://jellyfin.example.com' }, { localAddresses: () => ['192.168.1.81'] }), /HTTPS/)
  assert.throws(() => jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'https://user:pass@jellyfin.example.com' }), /username or password/)
  assert.throws(() => jellyfinConfig({ TOMIFY_JELLYFIN_URL: 'not a url' }), /must be a URL/)
})

test('an administrator signs in, and the session is checked with Jellyfin at most every 30 seconds', async () => {
  const jellyfin = fakeJellyfin()
  let clock = 1_000
  const auth = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: jellyfin.fetchImpl, now: () => clock })
  assert.deepEqual(await auth.login({ username: 'tom', password: 'right' }), { token: adminToken, user: { name: 'tom' } })
  assert.match(jellyfin.calls[0][3], /^MediaBrowser Client="Tomifin Downloader", .*DeviceId="tomifin-[0-9a-f-]{36}"/)
  assert.equal((await auth.verify(adminToken)).name, 'tom')
  assert.equal(jellyfin.calls.filter(([, path]) => path === '/Users/Me').length, 0)
  clock += 31_000
  assert.equal((await auth.verify(adminToken)).isAdmin, true)
  assert.equal(jellyfin.calls.filter(([, path]) => path === '/Users/Me').length, 1)
  // Signed out in Jellyfin (or the token revoked there): Tomifin stops accepting it once the cache runs out.
  jellyfin.sessions.delete(adminToken)
  clock += 31_000
  await rejects(auth.verify(adminToken), 'unauthorized')
})

test('someone who is not a Jellyfin administrator is refused and their new session is closed', async () => {
  const jellyfin = fakeJellyfin()
  const auth = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: jellyfin.fetchImpl })
  await rejects(auth.login({ username: 'kid', password: 'right' }), 'forbidden')
  assert.deepEqual(jellyfin.calls.at(-1).slice(0, 3), ['POST', '/Sessions/Logout', viewerToken])
  await rejects(auth.verify(viewerToken), 'unauthorized')
})

test('a wrong password, a malformed token, a missing setup and an unreachable Jellyfin are told apart', async () => {
  const jellyfin = fakeJellyfin()
  const auth = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: jellyfin.fetchImpl })
  await rejects(auth.login({ username: 'tom', password: 'wrong' }), 'invalid-login')
  await rejects(auth.login({ username: '', password: 'right' }), 'invalid-login')
  await rejects(auth.verify('short'), 'unauthorized')
  await rejects(auth.verify('"; Token="x'.padEnd(40, 'x')), 'unauthorized')
  assert.equal(jellyfin.calls.filter(([, path]) => path === '/Users/Me').length, 0)
  const off = createJellyfinAuth(null)
  assert.equal(off.configured, false)
  await rejects(off.login({ username: 'tom', password: 'right' }), 'not-configured')
  await rejects(off.verify(adminToken), 'not-configured')
  const down = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  await rejects(down.verify(adminToken), 'jellyfin-unavailable')
  const broken = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: async () => new Response('', { status: 500 }) })
  await rejects(broken.verify(adminToken), 'jellyfin-unavailable')
})

test('signing out closes the Jellyfin session', async () => {
  const jellyfin = fakeJellyfin()
  const auth = createJellyfinAuth({ url: 'http://127.0.0.1:8096' }, { fetchImpl: jellyfin.fetchImpl })
  await auth.login({ username: 'tom', password: 'right' })
  assert.deepEqual(await auth.logout(adminToken), { signedOut: true })
  assert.deepEqual(jellyfin.calls.at(-1).slice(0, 3), ['POST', '/Sessions/Logout', adminToken])
  await rejects(auth.verify(adminToken), 'unauthorized')
  assert.deepEqual(await auth.logout('nonsense'), { signedOut: true })
})
