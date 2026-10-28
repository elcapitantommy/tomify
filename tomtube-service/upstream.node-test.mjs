import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllowed, isAllowedUpstream, parseRange, readRange, upstreamHeaders, UpstreamError } from './upstream.mjs'
import { fakeYouTube } from './testing.mjs'

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('only googlevideo media and i.ytimg.com images can be fetched', () => {
  assert.equal(isAllowedUpstream('https://rr3---sn-4g5e6nsz.googlevideo.com/videoplayback?x=1'), true)
  assert.equal(isAllowedUpstream('https://googlevideo.com/x'), true)
  for (const url of ['http://rr3.googlevideo.com/x', 'https://googlevideo.com.evil.test/x', 'https://evilgooglevideo.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://user:pw@rr3.googlevideo.com/x', 'https://rr3.googlevideo.com:8080/x', 'https://i.ytimg.com/vi/x/hqdefault.jpg', 'file:///etc/passwd', 'not a url']) {
    assert.equal(isAllowedUpstream(url), false, url)
  }
  assert.equal(isAllowedUpstream('https://i.ytimg.com/vi/x/hqdefault.jpg', 'image'), true)
  assert.equal(isAllowedUpstream('https://rr3.googlevideo.com/x', 'image'), false)
})

test('a redirect away from YouTube\'s servers is refused', async () => {
  const fetch = async (url) => String(url).includes('googlevideo') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) : new Response('secret')
  await assert.rejects(fetchAllowed('https://rr1.googlevideo.com/v', { fetch }), (error) => error instanceof UpstreamError && error.code === 'upstream-refused')
  let hops = 0
  const allowedRedirect = async () => (++hops === 1 ? new Response(null, { status: 302, headers: { location: 'https://rr9.googlevideo.com/v' } }) : new Response('ok'))
  assert.equal(await (await fetchAllowed('https://rr1.googlevideo.com/v', { fetch: allowedRedirect })).text(), 'ok')
})

test('request headers from yt-dlp never forward cookies or credentials', () => {
  assert.deepEqual(upstreamHeaders({ 'User-Agent': 'ua', Cookie: 'SID=1', Authorization: 'x', Range: 'bytes=0-', Origin: 'https://www.youtube.com' }), { 'user-agent': 'ua', origin: 'https://www.youtube.com' })
})

test('Range headers are parsed the way browsers and AVPlayer send them', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 })
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=50-10', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('bytes=0-1,5-6', 100), null)
  assert.equal(parseRange('items=0-1', 100), null)
})

test('a range is read in chunks no bigger than YouTube allows', async () => {
  const file = Buffer.from(Array.from({ length: 1000 }, (_, index) => index & 0xff))
  const youtube = fakeYouTube({ '/v': file })
  const format = { url: 'https://rr1.googlevideo.com/v?expire=1', headers: { 'User-Agent': 'ua' } }
  const bytes = await collect(readRange(format, 100, 899, { fetch: youtube.fetch, chunkSize: 300 }))
  assert.deepEqual(bytes, file.subarray(100, 900))
  assert.deepEqual(youtube.requests.map((request) => request.range), ['bytes=100-399', 'bytes=400-699', 'bytes=700-899'])
  assert.equal(youtube.requests[0].headers['user-agent'], 'ua')
})

test('an expired address is renewed once and reading carries on from the same byte', async () => {
  const file = Buffer.alloc(1000, 7)
  const youtube = fakeYouTube({ '/v': file }, { expired: new Set(['old']) })
  let refreshed = 0
  const refresh = async () => { refreshed += 1; return { url: 'https://rr2.googlevideo.com/v?expire=new', headers: {} } }
  const bytes = await collect(readRange({ url: 'https://rr1.googlevideo.com/v?expire=old', headers: {} }, 0, 999, { fetch: youtube.fetch, refresh, chunkSize: 400 }))
  assert.equal(bytes.length, 1000)
  assert.equal(refreshed, 1)
  await assert.rejects(collect(readRange({ url: 'https://rr1.googlevideo.com/v?expire=old', headers: {} }, 0, 9, { fetch: youtube.fetch, refresh: async () => ({ url: 'https://rr1.googlevideo.com/v?expire=old', headers: {} }) })), (error) => error.code === 'upstream-expired')
})

test('a dropped connection resumes where it stopped', async () => {
  const file = Buffer.from(Array.from({ length: 600 }, (_, index) => index % 251))
  const youtube = fakeYouTube({ '/v': file })
  let calls = 0
  const flaky = async (url, init) => {
    calls += 1
    const response = await youtube.fetch(url, init)
    if (calls !== 1) return response
    // The first response sends 100 bytes and then breaks.
    const body = new Uint8Array(await response.arrayBuffer()).subarray(0, 100)
    const stream = new ReadableStream({ start(controller) { controller.enqueue(body) }, pull(controller) { controller.error(new Error('reset')) } })
    return new Response(stream, { status: 206 })
  }
  const bytes = await collect(readRange({ url: 'https://rr1.googlevideo.com/v', headers: {} }, 0, 599, { fetch: flaky }))
  assert.deepEqual(bytes, file)
  assert.equal(youtube.requests[1].range, 'bytes=100-599')
})

test('stopping the reader (the phone went away) ends without error', async () => {
  const youtube = fakeYouTube({ '/v': Buffer.alloc(1000) })
  const controller = new AbortController()
  controller.abort()
  assert.equal((await collect(readRange({ url: 'https://rr1.googlevideo.com/v', headers: {} }, 0, 999, { fetch: youtube.fetch, signal: controller.signal }))).length, 0)
  assert.equal(youtube.requests.length, 0)
})
