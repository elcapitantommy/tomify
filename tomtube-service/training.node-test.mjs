import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelAffinity, cookieKey, createTraining, decryptCookies, encryptCookies, isSignedOut, parseChannelFeed, parseCookieFile, topicPhrases } from './training.mjs'
import { createHandler } from './server.mjs'
import { YtDlpError, feedArguments } from './ytdlp.mjs'
import { isAllowedUpstream } from './upstream.mjs'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const FUTURE = Math.floor(NOW / 1000) + 365 * 86400
const SECRET = 'AbCdEfGhIjKlMnOp-secret-sapisid'
const COOKIES = [
  '# Netscape HTTP Cookie File',
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSAPISID\t${SECRET}`,
  `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${FUTURE + 100}\tLOGIN_INFO\tlogin-info-value-123`,
  `.youtube.com\tTRUE\t/\tTRUE\t100\tOLD\texpired-cookie-value`,
  `.google.com\tTRUE\t/\tTRUE\t${FUTURE}\tSID\tgoogle-sid-should-not-be-kept`,
].join('\n')
const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const CHANNEL_C = 'UCcccccccccccccccccccccc'

const entry = (id, title, channel, channelId) => ({ id, title, channel, channel_id: channelId, ie_key: 'Youtube', duration: 600 })
const id = (n) => `vid${String(n).padStart(8, '0')}`

function feedXml(channelId, channel, videos) {
  return `<?xml version="1.0"?><feed><author><name>${channel}</name></author>${videos.map((video) => `<entry><yt:videoId>${video.id}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>${video.title}</title><author><name>${channel}</name></author><published>${video.published}</published><media:group><media:community><media:statistics views="${video.views || 0}"/></media:community></media:group></entry>`).join('')}</feed>`
}

function fakeYtDlp({ signedOut = false, feeds = {} } = {}) {
  const calls = []
  return {
    calls,
    async feed(name, limit, cookies) {
      calls.push({ name, limit, cookies })
      if (signedOut) throw Object.assign(new YtDlpError('extraction-failed', 'yt-dlp failed: ERROR: [youtube:tab] :ythistory: This feed requires login. Use --cookies'), { detail: 'This feed requires login' })
      return { data: { entries: feeds[name] || [] }, warnings: '', jar: null }
    },
  }
}

async function tempDir() { return mkdtemp(join(tmpdir(), 'tomtube-training-test-')) }

test('cookie files keep only signed-in youtube.com cookies', () => {
  const parsed = parseCookieFile(COOKIES, NOW)
  assert.equal(parsed.count, 2)
  assert.match(parsed.file, /SAPISID/)
  assert.match(parsed.file, /#HttpOnly_\.youtube\.com/)
  assert.doesNotMatch(parsed.file, /google-sid|expired-cookie/)
  assert.equal(parsed.expiresAt, new Date(FUTURE * 1000).toISOString())
  assert.throws(() => parseCookieFile('.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tf1=1', NOW), { code: 'cookies-not-signed-in' })
  assert.throws(() => parseCookieFile('hello', NOW), { code: 'invalid-cookies' })
  assert.throws(() => parseCookieFile('x'.repeat(300 * 1024), NOW), { code: 'cookies-too-large' })
  const json = JSON.stringify([{ domain: '.youtube.com', name: '__Secure-3PAPISID', value: 'json-secret-value', path: '/', secure: true, expirationDate: FUTURE }, { domain: 'accounts.google.com', name: 'x', value: 'y', path: '/' }])
  const fromJson = parseCookieFile(json, NOW)
  assert.equal(fromJson.count, 1)
  assert.match(fromJson.file, /^\.youtube\.com\tTRUE\t\/\tTRUE\t\d+\t__Secure-3PAPISID\tjson-secret-value$/m)
})

test('signed-out messages are told apart from bot checks and network failures', () => {
  assert.equal(isSignedOut('WARNING: The provided YouTube account cookies are no longer valid.'), true)
  assert.equal(isSignedOut('ERROR: This feed requires login. Use --cookies'), true)
  assert.equal(isSignedOut('Sign in to confirm you are not a bot', 'bot-check'), false)
  assert.equal(isSignedOut('The server could not reach YouTube.', 'network'), false)
  assert.equal(isSignedOut(''), false)
})

test('feed arguments are fixed names with warnings left on', () => {
  const args = feedArguments({ cacheDir: null }, ':ytrec', 60, '/tmp/x/cookies.txt')
  assert.deepEqual(args.slice(-6), ['--flat-playlist', '--playlist-end', '60', '--dump-single-json', '--', ':ytrec'])
  assert.equal(args.includes('--no-warnings'), false)
  assert.equal(args[args.indexOf('--cookies') + 1], '/tmp/x/cookies.txt')
  assert.equal(args.at(-1), ':ytrec')
  assert.throws(() => feedArguments({}, 'https://evil.test/', 5, null))
})

test('only channel RSS feeds are fetched from www.youtube.com', () => {
  assert.equal(isAllowedUpstream(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_A}`, 'feed'), true)
  assert.equal(isAllowedUpstream('https://www.youtube.com/feeds/videos.xml?user=x', 'feed'), false)
  assert.equal(isAllowedUpstream(`https://www.youtube.com/watch?channel_id=${CHANNEL_A}`, 'feed'), false)
  assert.equal(isAllowedUpstream(`https://evil.test/feeds/videos.xml?channel_id=${CHANNEL_A}`, 'feed'), false)
  assert.equal(isAllowedUpstream(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_A}`, 'media'), false)
})

test('channel feeds are parsed into videos', () => {
  const videos = parseChannelFeed(feedXml(CHANNEL_A, 'Chan &amp; Co', [{ id: id(1), title: 'First &quot;one&quot;', published: '2026-10-27T10:00:00+00:00', views: 1234 }]))
  assert.deepEqual(videos, [{ id: id(1), title: 'First "one"', channel: 'Chan & Co', channelId: CHANNEL_A, duration: null, viewCount: 1234, isLive: false, publishedAt: '2026-10-27T10:00:00.000Z' }])
})

test('topics come from titles that recur', () => {
  const titles = ['Building a Raspberry Pi NAS', 'Raspberry Pi cluster build', 'My Raspberry Pi home server (Official Video)', 'Sourdough bread at home', 'Easy sourdough starter']
  assert.deepEqual(topicPhrases(titles, 3), ['raspberry pi', 'home', 'sourdough'])
  assert.deepEqual(topicPhrases(['one title only'], 3), [])
})

test('cookie encryption round-trips and plain files still read', () => {
  const key = cookieKey('k'.repeat(40))
  assert.equal(decryptCookies(encryptCookies('hello', key), key), 'hello')
  assert.notEqual(encryptCookies('hello', key), encryptCookies('hello', key))
  assert.equal(decryptCookies('# plain\n', key), '# plain')
})

test('channel affinity weighs signals: recommendations are not likes, skips and Not interested count against', () => {
  const data = {
    watches: {
      [id(1)]: { channelId: CHANNEL_A, channel: 'A', duration: 600, seconds: 300, plays: 1, lastAt: NOW },
      [id(2)]: { channelId: CHANNEL_B, channel: 'B', duration: 600, seconds: 4, skipped: true, plays: 1, lastAt: NOW },
      [id(3)]: { channelId: CHANNEL_C, channel: 'C', duration: 600, seconds: 600, finished: true, plays: 1, lastAt: NOW },
      [id(4)]: { channelId: CHANNEL_C, channel: 'C', duration: 600, seconds: 500, finished: true, plays: 1, lastAt: NOW },
    },
    youtubeHistory: {},
    subscriptions: {},
    notInterested: { [id(5)]: { id: id(5), channelId: CHANNEL_A, at: NOW } },
    recommendedChannels: { UCdddddddddddddddddddddd: { channelId: 'UCdddddddddddddddddddddd', count: 50 } },
  }
  const ranked = channelAffinity(data, NOW)
  // C: two finished (3 + 3) and a repeat bonus (1); A: watched most (1.5) but Not interested (-4).
  assert.deepEqual(ranked.map((entry) => [entry.channelId, Math.round(entry.score * 10) / 10]), [[CHANNEL_C, 7], [CHANNEL_B, -0.5], [CHANNEL_A, -2.5]])
  assert.equal(ranked.find((entry) => entry.channelId === CHANNEL_A).rejected, true)
})

test('channel affinity favours finished, recent and subscribed channels', () => {
  const data = {
    watches: {
      [id(1)]: { channelId: CHANNEL_A, channel: 'A', finished: true, seconds: 600, plays: 2, lastAt: NOW },
      [id(2)]: { channelId: CHANNEL_B, channel: 'B', finished: false, seconds: 60, plays: 1, lastAt: NOW - 200 * 86400_000 },
    },
    youtubeHistory: {},
    subscriptions: { [CHANNEL_C]: { channelId: CHANNEL_C, channel: 'C' } },
  }
  const ranked = channelAffinity(data, NOW)
  assert.deepEqual(ranked.map((entry) => entry.channelId), [CHANNEL_A, CHANNEL_C, CHANNEL_B])
  assert.equal(ranked[1].subscribed, true)
  assert.equal(ranked[1].watched, false)
})

test('training: cookies are stored privately, synced, and never reported back', async () => {
  const dir = await tempDir()
  try {
    const ytdlp = fakeYtDlp({ feeds: {
      ':ythistory': [entry(id(1), 'Watched on YouTube', 'A', CHANNEL_A)],
      ':ytsubs': [entry(id(2), 'Sub upload', 'C', CHANNEL_C)],
      ':ytrec': [entry(id(3), 'Rec one', 'B', CHANNEL_B), entry(id(1), 'Watched on YouTube', 'A', CHANNEL_A)],
    } })
    const training = await createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp, now: () => NOW, secret: 's'.repeat(40) }).forUser('tom', { owner: true })
    assert.equal((await training.status()).cookies.state, 'missing')
    await training.setCookies(COOKIES)
    // Stored encrypted; yt-dlp gets the plain youtube.com cookies only.
    const file = await readFile(training.paths.cookieFile, 'utf8')
    assert.match(file, /^TTC1:/)
    assert.doesNotMatch(file, /SAPISID|youtube\.com/)
    assert.doesNotMatch(decryptCookies(file, cookieKey('s'.repeat(40))), /google-sid/)
    assert.throws(() => decryptCookies(file, cookieKey('other key')), { code: 'cookies-unreadable' })
    assert.equal((await stat(training.paths.cookieFile)).mode & 0o777, 0o600)
    assert.equal((await stat(join(dir, 'secrets'))).mode & 0o777, 0o700)

    const status = await training.sync()
    assert.equal(status.cookies.state, 'valid')
    assert.deepEqual(ytdlp.calls.map((call) => call.name), [':ythistory', ':ytsubs', ':ytrec'])
    assert.match(ytdlp.calls[0].cookies, new RegExp(`SAPISID\t${SECRET}`))
    assert.doesNotMatch(ytdlp.calls[0].cookies, /google-sid/)
    assert.equal((await training.status()).cookies.encrypted, true)
    assert.equal(status.learned.youtubeHistory, 1)
    assert.equal(status.learned.subscriptions, 1)
    assert.equal(status.learned.recommendedChannels, 2)
    const everything = JSON.stringify(status) + await readFile(training.paths.dataFile, 'utf8')
    assert.doesNotMatch(everything, new RegExp(SECRET))
    assert.doesNotMatch(everything, /login-info-value|tom\.cookies/)

    // YouTube's own recommendations come first, without what was already watched.
    const recommendations = await training.recommendations()
    assert.equal(recommendations.source, 'youtube')
    assert.deepEqual(recommendations.shelves[0].videos.map((video) => video.id), [id(3)])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('training: expired cookies are reported and syncing stops', async () => {
  const dir = await tempDir()
  try {
    const ytdlp = fakeYtDlp({ signedOut: true })
    const training = await createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp, now: () => NOW }).forUser('tom', { owner: true })
    await training.setCookies(COOKIES)
    const status = await training.sync()
    assert.equal(status.cookies.state, 'expired')
    assert.equal(status.cookies.lastError.code, 'cookies-expired')
    assert.equal(status.cookies.nextSyncAt, null)
    assert.equal(ytdlp.calls.length, 1)
    // Renewing them puts it back to checking, then valid.
    const renewed = await createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp: fakeYtDlp(), now: () => NOW }).forUser('Tom', { owner: true })
    await renewed.setCookies(COOKIES)
    assert.equal((await renewed.sync()).cookies.state, 'valid')
    assert.equal((await renewed.removeCookies()).cookies.state, 'missing')
    await assert.rejects(readFile(renewed.paths.cookieFile))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('training: after expiry, suggestions come from the watch log', async () => {
  const dir = await tempDir()
  let now = NOW
  try {
    const ytdlp = fakeYtDlp({ feeds: { ':ytrec': [entry(id(20), 'Rec', 'Disco', CHANNEL_C)] } })
    const searches = []
    const rss = {
      [CHANNEL_A]: feedXml(CHANNEL_A, 'Alpha', [{ id: id(10), title: 'Alpha new', published: '2026-10-27T00:00:00Z' }, { id: id(1), title: 'Already watched', published: '2026-10-20T00:00:00Z' }, { id: id(11), title: 'Alpha ancient', published: '2025-01-01T00:00:00Z' }]),
      [CHANNEL_C]: feedXml(CHANNEL_C, 'Disco', [{ id: id(30), title: 'Disco upload', published: '2026-10-26T00:00:00Z' }]),
    }
    const fetch = async (url) => {
      const channel = new URL(url).searchParams.get('channel_id')
      return rss[channel] ? new Response(rss[channel]) : new Response('', { status: 404 })
    }
    const training = await createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp, fetch, now: () => now, search: async (query, limit) => { searches.push({ query, limit }); return { entries: [entry(id(40), `${query} deep dive`, 'Other', 'UCeeeeeeeeeeeeeeeeeeeeee'), entry(id(41), 'From a skipped channel', 'Skippy', CHANNEL_B), entry(id(1), 'Already watched', 'Alpha', CHANNEL_A)] } } }).forUser('tom', { owner: true })
    await training.setCookies(COOKIES)
    // Two syncs a day apart: Disco is recommended twice.
    await training.sync()
    now += 86400_000
    await training.sync()
    for (const [n, title] of [[1, 'Raspberry Pi NAS build'], [2, 'Raspberry Pi cluster']]) {
      await training.recordWatch({ id: id(n), title, channel: 'Alpha', channelId: CHANNEL_A, duration: 600, seconds: 590, ended: true })
    }
    await assert.rejects(training.recordWatch({ id: 'nope' }), { code: 'invalid-watch' })
    // A channel skipped after a few seconds is not suggested; nor is a video marked Not interested.
    await training.recordWatch({ id: id(50), title: 'Skipped', channel: 'Skippy', channelId: CHANNEL_B, duration: 600, seconds: 3, skipped: true })
    await training.recordFeedback({ id: id(11), kind: 'not-interested', channelId: CHANNEL_A, channel: 'Alpha' })
    await assert.rejects(training.recordFeedback({ id: id(12), kind: 'love' }), { code: 'invalid-feedback' })
    // Three days later the YouTube snapshot is stale.
    now += 3 * 86400_000
    const result = await training.recommendations({ refresh: true })
    assert.equal(result.source, 'training')
    const shelves = Object.fromEntries(result.shelves.map((shelf) => [shelf.id, shelf.videos.map((video) => video.id)]))
    assert.deepEqual(shelves.channels, [id(10)])
    assert.deepEqual(shelves.discover, [id(30)])
    assert.deepEqual(shelves.topics, [id(40)])
    assert.deepEqual(searches.map((call) => call.query), ['raspberry pi'])
    assert.match(result.shelves.find((shelf) => shelf.id === 'discover').videos[0].reason, /suggested Disco 2 times/)
    // Cached until refreshed.
    assert.equal(await training.recommendations(), result)

    // Clearing forgets the log but keeps the cookies.
    const cleared = await training.clear()
    assert.equal(cleared.learned.watches, 0)
    assert.equal(cleared.learned.recommendedChannels, 0)
    assert.notEqual(cleared.cookies.state, 'missing')
    assert.equal((await training.recommendations({ refresh: true })).source, 'none')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('service: training endpoints, without ever returning the cookies', async () => {
  const dir = await tempDir()
  const training = createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp: fakeYtDlp(), now: () => NOW, fetch: async () => new Response('', { status: 404 }) })
  const token = 't'.repeat(40)
  const handler = createHandler({ config: { token, maxStreams: 1, searchLimit: 5, cache: {} }, ytdlp: { limiter: {} }, resolver: {}, training })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, 'x-tomtube-profile': 'tom', 'x-tomtube-owner': '1', ...init.headers } })
  const guest = (path, init = {}) => call(path, { ...init, headers: { 'x-tomtube-profile': 'anna', 'x-tomtube-owner': '0', ...init.headers } })
  try {
    assert.equal((await fetch(`${base}/v1/training`)).status, 401)
    // A profile is required, and only owners may touch the cookies or sync.
    assert.equal((await call('/v1/recommendations', { headers: { 'x-tomtube-profile': '' } })).status, 400)
    assert.equal((await guest('/v1/training/cookies', { method: 'PUT', body: COOKIES })).status, 403)
    assert.equal((await guest('/v1/training/cookies', { method: 'DELETE' })).status, 403)
    assert.equal((await guest('/v1/training/sync', { method: 'POST' })).status, 403)
    assert.equal((await (await guest('/v1/training')).json()).youtubeAccount, false)
    const put = await call('/v1/training/cookies', { method: 'PUT', body: COOKIES, headers: { 'content-type': 'text/plain' } })
    assert.equal(put.status, 200)
    const putText = await put.text()
    assert.doesNotMatch(putText, new RegExp(`${SECRET}|login-info|secrets|cookies\\.txt`))
    assert.equal((await call('/v1/training/cookies', { method: 'PUT', body: 'nonsense' })).status, 400)
    assert.equal((await call('/v1/training/cookies', { method: 'PUT', body: 'x'.repeat(300 * 1024) })).status, 413)
    assert.equal((await call('/v1/training/cookies', { method: 'GET' })).status, 405)
    assert.equal((await call('/v1/watched', { method: 'POST', body: JSON.stringify({ id: id(1), title: 'T', channel: 'C', channelId: CHANNEL_A, seconds: 40, duration: 100 }) })).status, 200)
    assert.equal((await call('/v1/watched', { method: 'POST', body: '{bad' })).status, 400)
    assert.equal((await call('/v1/watched')).status, 405)
    assert.equal((await call('/v1/feedback', { method: 'POST', body: JSON.stringify({ id: id(2), kind: 'not-interested' }) })).status, 200)
    assert.equal((await call('/v1/feedback', { method: 'POST', body: JSON.stringify({ id: id(2) }) })).status, 400)
    const status = await (await call('/v1/training')).json()
    assert.equal(status.learned.watches, 1)
    assert.equal(status.youtubeAccount, true)
    // Another account's watches and feedback stay in its own profile.
    assert.equal((await guest('/v1/watched', { method: 'POST', body: JSON.stringify({ id: id(3), seconds: 40, duration: 100 }) })).status, 200)
    const guestStatus = await (await guest('/v1/training')).json()
    assert.equal(guestStatus.learned.watches, 1)
    assert.equal(guestStatus.learned.notInterested, 0)
    assert.equal(guestStatus.cookies.state, 'missing')
    assert.equal((await (await guest('/v1/training', { method: 'DELETE' })).json()).learned.watches, 0)
    assert.equal((await (await call('/v1/training')).json()).learned.watches, 1)
    assert.ok(['checking', 'valid'].includes(status.cookies.state))
    assert.equal((await call('/v1/training/sync', { method: 'POST' })).status, 202)
    assert.equal((await call('/v1/recommendations')).status, 200)
    assert.equal((await (await call('/v1/training', { method: 'DELETE' })).json()).learned.watches, 0)
    assert.equal((await call('/v1/training/other')).status, 404)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
  const disabled = createServer(createHandler({ config: { token: 't'.repeat(40) }, ytdlp: {}, resolver: {} }))
  await new Promise((resolve) => disabled.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${disabled.address().port}/v1/recommendations`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })
    assert.equal(response.status, 503)
  } finally { disabled.closeAllConnections?.(); await new Promise((resolve) => disabled.close(resolve)) }
})

test('training: each account has its own profile, and only owners import from YouTube', async () => {
  const dir = await tempDir()
  try {
    const ytdlp = fakeYtDlp({ feeds: { ':ythistory': [entry(id(1), 'Watched on YouTube', 'A', CHANNEL_A)], ':ytrec': [entry(id(3), 'Rec one', 'B', CHANNEL_B)] } })
    const training = createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp, now: () => NOW, fetch: async () => new Response('', { status: 404 }) })
    const tom = await training.forUser('Tom', { owner: true })
    const anna = await training.forUser('anna')
    assert.equal(await training.forUser('tom', { owner: true }), tom)
    await assert.rejects(training.forUser('  '), { code: 'no-profile' })

    await tom.setCookies(COOKIES)
    await tom.sync()
    await anna.recordWatch({ id: id(7), title: 'Anna only', channel: 'C', channelId: CHANNEL_C, duration: 600, seconds: 600, ended: true })
    await anna.recordFeedback({ id: id(8), kind: 'not-interested', channelId: CHANNEL_A })
    const [tomStatus, annaStatus] = [await tom.status(), await anna.status()]
    assert.deepEqual([tomStatus.learned.watches, tomStatus.learned.notInterested, tomStatus.learned.youtubeHistory, tomStatus.cookies.state], [0, 0, 1, 'valid'])
    assert.deepEqual([annaStatus.learned.watches, annaStatus.learned.notInterested, annaStatus.learned.youtubeHistory, annaStatus.cookies.state], [1, 1, 0, 'missing'])
    // Tom's YouTube recommendations are only in Tom's suggestions.
    assert.equal((await tom.recommendations()).source, 'youtube')
    assert.notEqual((await anna.recommendations()).source, 'youtube')
    // A non-owner cannot add cookies or sync, even when called directly.
    await assert.rejects(anna.setCookies(COOKIES), { code: 'training-forbidden' })
    await assert.rejects(anna.sync(), { code: 'training-forbidden' })
    assert.equal(tom.paths.cookieFile, join(dir, 'secrets', 'users', 'tom.cookies'))
    assert.equal(anna.paths.dataFile, join(dir, 'training', 'users', 'anna', 'log.json'))
    assert.match(training.profileName('Odd/../Name'), /^h-[0-9a-f]{32}$/)

    // Once an account is no longer an owner, its cookies are no longer synced.
    const calls = ytdlp.calls.length
    await training.forUser('tom', { owner: false })
    await tom.syncIfDue()
    assert.equal(ytdlp.calls.length, calls)
    assert.equal((await tom.status()).youtubeAccount, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('training: the shared log from before profiles moves to the first owner', async () => {
  const dir = await tempDir()
  try {
    const before = createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp: fakeYtDlp(), now: () => NOW })
    const old = await before.forUser('setup', { owner: true })
    await old.setCookies(COOKIES)
    await old.recordWatch({ id: id(1), title: 'Old watch', seconds: 600, duration: 600, ended: true })
    // Put them where the server-wide version kept them.
    await mkdir(join(dir, 'secrets'), { recursive: true })
    await rename(old.paths.dataFile, join(dir, 'training', 'log.json'))
    await rename(old.paths.cookieFile, join(dir, 'secrets', 'youtube-training.cookies'))

    const training = createTraining({ feedPauseMs: 0, stateDir: dir, ytdlp: fakeYtDlp(), now: () => NOW })
    // A listener who is not an owner never gets it.
    assert.equal((await (await training.forUser('anna')).status()).learned.watches, 0)
    const tom = await training.forUser('tom', { owner: true })
    const status = await tom.status()
    assert.equal(status.learned.watches, 1)
    assert.notEqual(status.cookies.state, 'missing')
    await assert.rejects(stat(join(dir, 'training', 'log.json')))
    await assert.rejects(stat(join(dir, 'secrets', 'youtube-training.cookies')))
    assert.equal((await stat(join(dir, 'secrets', 'users'))).mode & 0o777, 0o700)
    // A second owner starts fresh.
    assert.equal((await (await training.forUser('admin2', { owner: true })).status()).learned.watches, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
