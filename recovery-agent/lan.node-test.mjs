import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { corsHeaders, createLanHandler, DEFAULT_LAN_ALLOWED_ORIGINS, lanConfig, openMediaToken, signLanPlaylist, startLanServer } from './lan.mjs'
import { HlsError } from './hls.mjs'

const KEY = 'k'.repeat(40)
const LOGIN = { user: 'tom', token: 'a'.repeat(32), salt: 'abc123' }
const APP = 'https://app.tomify.tomdixon.uk'

// The Worker's seal() (worker/lib/seal.ts), written with node:crypto.
function seal(secret, text) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return iv.toString('base64') + '.' + data.toString('base64')
}
const tokenFor = (expiresAt, login = LOGIN, secret = KEY) => seal(secret, JSON.stringify([expiresAt, login.user, login.token, login.salt]))

test('LAN streaming stays off until the port, both certificate files and the media key are set', () => {
  assert.equal(lanConfig({}).enabled, false)
  assert.equal(lanConfig({}).problem, null)
  assert.equal(lanConfig({ TOMIFY_MEDIA_KEY: KEY }).problem, null)
  assert.match(lanConfig({ TOMIFY_LAN_PORT: '8789', TOMIFY_MEDIA_KEY: KEY }).problem, /TOMIFY_LAN_TLS_CERT/)
  assert.match(lanConfig({ TOMIFY_LAN_PORT: 'many', TOMIFY_LAN_TLS_CERT: 'c', TOMIFY_LAN_TLS_KEY: 'k', TOMIFY_MEDIA_KEY: KEY }).problem, /TOMIFY_LAN_PORT/)
  assert.match(lanConfig({ TOMIFY_LAN_PORT: '8789', TOMIFY_LAN_TLS_CERT: 'c', TOMIFY_LAN_TLS_KEY: 'k', TOMIFY_MEDIA_KEY: 'short' }).problem, /TOMIFY_MEDIA_KEY/)
  const config = lanConfig({ TOMIFY_LAN_PORT: '8789', TOMIFY_LAN_TLS_CERT: join('etc', 'cert.pem'), TOMIFY_LAN_TLS_KEY: join('etc', 'key.pem'), TOMIFY_MEDIA_KEY: KEY })
  assert.equal(config.enabled, true)
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.port, 8789)
  assert.deepEqual(config.allowedOrigins, [...DEFAULT_LAN_ALLOWED_ORIGINS])
  assert.deepEqual(lanConfig({ TOMIFY_LAN_ALLOWED_ORIGINS: 'https://a.example/, https://b.example' }).allowedOrigins, ['https://a.example', 'https://b.example'])
})

test('media tokens open only with the right key, untampered and before they expire', () => {
  const now = 1_000_000
  assert.deepEqual(openMediaToken(KEY, tokenFor(now + 1000), now), LOGIN)
  assert.equal(openMediaToken(KEY, tokenFor(now - 1), now), null)
  assert.equal(openMediaToken('x'.repeat(40), tokenFor(now + 1000), now), null)
  assert.equal(openMediaToken('', tokenFor(now + 1000, LOGIN, ''), now), null)
  const [iv, data] = tokenFor(now + 1000).split('.')
  const bytes = Buffer.from(data, 'base64')
  bytes[0] ^= 1
  assert.equal(openMediaToken(KEY, `${iv}.${bytes.toString('base64')}`, now), null)
  assert.equal(openMediaToken(KEY, tokenFor(now + 1000, { ...LOGIN, token: 'not-md5' }), now), null)
  for (const bad of [null, '', 'abc', 'a.b', `${iv}.${data}.x`]) assert.equal(openMediaToken(KEY, bad, now), null)
})

test('playlist lines naming playlists and chunks carry the token; tags do not', () => {
  assert.equal(signLanPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8\n#EXTINF:6,\nseg00001.ts\nhttps://x/y\n', 'mt=a%2Bb'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8?mt=a%2Bb\n#EXTINF:6,\nseg00001.ts?mt=a%2Bb\nhttps://x/y\n')
})

test('CORS answers only the app origins', () => {
  const config = lanConfig({})
  assert.equal(corsHeaders(config, { origin: APP })['access-control-allow-origin'], APP)
  assert.equal(corsHeaders(config, { origin: 'https://evil.example' })['access-control-allow-origin'], undefined)
  assert.equal(corsHeaders(config, {})['access-control-allow-origin'], undefined)
})

async function withLanServer(options, callback) {
  const handler = createLanHandler({ config: { ...lanConfig({}), mediaKey: KEY }, navidromeUrl: 'http://navidrome.box:4533', ...options })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { await callback(base) } finally { await new Promise((resolve) => server.close(resolve)) }
}

test('preflight allows the app origin and private-network access; other origins are refused', async () => {
  await withLanServer({}, async (base) => {
    const allowed = await fetch(`${base}/navidrome/rest/stream.view`, { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } })
    assert.equal(allowed.status, 204)
    assert.equal(allowed.headers.get('access-control-allow-origin'), APP)
    assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true')
    assert.match(allowed.headers.get('access-control-allow-headers'), /range/)
    const refused = await fetch(`${base}/lan/ping`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    assert.equal(refused.status, 403)
    const ping = await fetch(`${base}/lan/ping`, { headers: { origin: APP } })
    assert.equal(ping.status, 200)
    assert.equal(ping.headers.get('access-control-allow-origin'), APP)
    assert.equal((await fetch(`${base}/lan/ping`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/rest/ping.view?mt=x`)).status, 404)
  })
})

test('streams come from Navidrome on the box with the login from the token, never from a login in the URL', async () => {
  const calls = []
  const fetcher = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return new Response('abc', { status: 206, headers: { 'content-type': 'audio/flac', 'content-range': 'bytes 0-2/10', 'content-length': '3', 'accept-ranges': 'bytes', 'set-cookie': 'nope' } }) }
  await withLanServer({ fetch: fetcher }, async (base) => {
    assert.equal((await fetch(`${base}/navidrome/rest/stream.view?id=tr1&u=tom&t=${LOGIN.token}&s=${LOGIN.salt}`)).status, 401)
    assert.equal((await fetch(`${base}/navidrome/rest/stream.view?id=tr1&mt=${encodeURIComponent(tokenFor(Date.now() - 1))}`)).status, 401)
    assert.equal(calls.length, 0)
    const response = await fetch(`${base}/navidrome/rest/stream.view?id=tr1&estimateContentLength=true&u=someone-else&mt=${encodeURIComponent(tokenFor(Date.now() + 60_000))}`, { headers: { origin: APP, range: 'bytes=0-2' } })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'abc')
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/10')
    assert.equal(response.headers.get('access-control-allow-origin'), APP)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(calls[0].url.origin + calls[0].url.pathname, 'http://navidrome.box:4533/rest/stream.view')
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { id: 'tr1', estimateContentLength: 'true', u: 'tom', t: LOGIN.token, s: LOGIN.salt })
    assert.equal(calls[0].init.headers.range, 'bytes=0-2')
  })
})

test('adaptive streaming goes through the packager and every playlist line carries the token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tomify-lan-'))
  const chunk = join(directory, 'seg00000.ts')
  await writeFile(chunk, 'chunk')
  const handled = []
  const hls = {
    async handle(target, credentials) {
      handled.push({ target, credentials })
      if (target.kind === 'master') return { contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\nv0/index.m3u8\n' }
      if (target.kind === 'segment' && target.index === 9) throw new HlsError(404, 'not-found', 'No such chunk.')
      return { contentType: 'video/mp2t', filePath: chunk }
    },
  }
  const mt = tokenFor(Date.now() + 60_000)
  try {
    await withLanServer({ hls }, async (base) => {
      const master = await fetch(`${base}/api/hls/tr1/album/master.m3u8?mt=${encodeURIComponent(mt)}`)
      assert.equal(master.status, 200)
      assert.equal(await master.text(), `#EXTM3U\nv0/index.m3u8?${new URLSearchParams({ mt })}\n`)
      assert.deepEqual(handled[0], { target: { trackId: 'tr1', gain: 'album', kind: 'master' }, credentials: { ...LOGIN, origin: null } })
      const segment = await fetch(`${base}/api/hls/tr1/v0/seg00000.ts?mt=${encodeURIComponent(mt)}`)
      assert.equal(await segment.text(), 'chunk')
      assert.equal(segment.headers.get('content-length'), '5')
      assert.equal((await fetch(`${base}/api/hls/tr1/v0/seg00009.ts?mt=${encodeURIComponent(mt)}`)).status, 404)
      assert.equal((await fetch(`${base}/api/hls/tr1/master.m3u8`)).status, 401)
      assert.equal((await fetch(`${base}/api/hls/..%2Fx/master.m3u8?mt=${encodeURIComponent(mt)}`)).status, 404)
      assert.equal(handled.length, 3)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a missing certificate stops only the LAN listener, with a clear error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tomify-lan-tls-'))
  try {
    await assert.rejects(startLanServer({ ...lanConfig({}), port: 0, host: '127.0.0.1', certFile: join(directory, 'fullchain.pem'), keyFile: join(directory, 'privkey.pem') }, () => {}), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
