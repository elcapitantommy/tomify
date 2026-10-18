import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_TORRENT_MAX_ACTIVE, checkArchiveListing, createQbittorrentClient, extractArchives, findArchives, isExtractableArchive, parseTorrentLink, qbittorrentJobState, qbittorrentQueuePreferences, torrentCandidate, torrentConfig, torrentSearchCandidates, torrentTransferDetails } from './torrent.mjs'

const hash = '0123456789abcdef0123456789abcdef01234567'

test('magnet links are parsed to an info hash and shown without trackers', () => {
  const parsed = parseTorrentLink(`magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=Flood%20(1990)%20FLAC&tr=https%3A%2F%2Ftracker.test%2Fpasskey123%2Fannounce`)
  assert.equal(parsed.type, 'magnet')
  assert.equal(parsed.infoHash, hash)
  assert.equal(parsed.name, 'Flood (1990) FLAC')
  assert.equal(parsed.displayUrl, `magnet:?xt=urn:btih:${hash}&dn=Flood%20(1990)%20FLAC`)
  assert.match(parsed.link, /passkey123/)
})

test('base32 magnet hashes are converted to hex', () => {
  // 32 base32 characters encode the same 20 bytes as 40 hex characters.
  assert.equal(parseTorrentLink('magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH').infoHash, hash)
})

test('invalid and unsafe torrent links are refused', () => {
  assert.throws(() => parseTorrentLink(''), /Paste a magnet link/)
  assert.throws(() => parseTorrentLink('magnet:?dn=no-hash'), /no BitTorrent info hash/)
  assert.throws(() => parseTorrentLink('magnet:?xt=urn:btih:nothex'), /invalid info hash/)
  assert.throws(() => parseTorrentLink('ftp://example.com/a.torrent'), /magnet links or http/)
  assert.throws(() => parseTorrentLink('http://127.0.0.1:8081/api/v2/app/shutdown'), /public host/)
  assert.throws(() => parseTorrentLink('http://192.168.1.10/a.torrent'), /public host/)
  assert.throws(() => parseTorrentLink('https://localhost/a.torrent'), /public host/)
  assert.throws(() => parseTorrentLink('https://user:pass@example.com/a.torrent'), /username or password/)
})

test('.torrent links keep the full URL for qBittorrent but display it without a query string', () => {
  const parsed = parseTorrentLink('https://tracker.example.com/download/Flood%20FLAC.torrent?passkey=secret')
  assert.equal(parsed.type, 'url')
  assert.equal(parsed.name, 'Flood FLAC')
  assert.equal(parsed.displayUrl, 'https://tracker.example.com/download/Flood%20FLAC.torrent')
  assert.match(parsed.link, /passkey=secret/)
})

test('a torrent candidate imports a whole release when the wanted music has no track title', () => {
  const album = torrentCandidate(`magnet:?xt=urn:btih:${hash}&dn=Flood`, { artist: 'They Might Be Giants', album: 'Flood', title: '' })
  assert.equal(album.provenance.searchMode, 'release')
  assert.equal(album.provenance.providerType, 'torrent')
  assert.equal(album.title, 'Flood')
  assert.equal(album.channel, 'Torrent link')
  const track = torrentCandidate(`magnet:?xt=urn:btih:${hash}`, { artist: 'They Might Be Giants', title: 'Birdhouse in Your Soul' })
  assert.equal(track.provenance.searchMode, 'track')
  assert.equal(track.title, 'Torrent 0123456789ab')
  assert.equal(album.externalId, track.externalId)
})

test('qBittorrent configuration requires loopback HTTP or HTTPS and defaults its category and size limit', () => {
  assert.equal(torrentConfig({}), null)
  const config = torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://127.0.0.1:8081/', TOMIFY_QBITTORRENT_USERNAME: 'tomify', TOMIFY_QBITTORRENT_PASSWORD: 'secret' })
  assert.deepEqual({ url: config.url, category: config.category, maxBytes: config.maxBytes }, { url: 'http://127.0.0.1:8081', category: 'tomify', maxBytes: 4 * 1024 ** 3 })
  assert.equal(config.maxFiles, 10000)
  assert.equal(torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://127.0.0.1:8081', TOMIFY_TORRENT_MAX_FILES: '20000' }).maxFiles, 20000)
  assert.equal(torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://127.0.0.1:8081', TOMIFY_TORRENT_MAX_FILES: '5' }).maxFiles, 10000)
  assert.throws(() => torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://192.168.1.5:8081' }), /HTTPS \(or loopback HTTP\)/)
})

test('torrents download five at a time by default, adjustable with TOMIFY_TORRENT_MAX_ACTIVE', () => {
  const url = 'http://127.0.0.1:8081'
  assert.equal(DEFAULT_TORRENT_MAX_ACTIVE, 5)
  assert.equal(torrentConfig({ TOMIFY_QBITTORRENT_URL: url }).maxActiveDownloads, 5)
  assert.equal(torrentConfig({ TOMIFY_QBITTORRENT_URL: url, TOMIFY_TORRENT_MAX_ACTIVE: '8' }).maxActiveDownloads, 8)
  for (const bad of ['0', '-1', '2.5', 'lots', '500']) assert.equal(torrentConfig({ TOMIFY_QBITTORRENT_URL: url, TOMIFY_TORRENT_MAX_ACTIVE: bad }).maxActiveDownloads, 5)
  assert.deepEqual(qbittorrentQueuePreferences(5), { queueing_enabled: true, max_active_downloads: 5, max_active_uploads: 5, max_active_torrents: 10 })
})

test('qBittorrent states map to queued, downloading, completed and failed jobs', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  assert.equal(qbittorrentJobState(null, { createdAt: '2026-10-15T11:59:30Z', now }).status, 'queued')
  assert.equal(qbittorrentJobState(null, { createdAt: '2026-10-15T11:50:00Z', now }).status, 'failed')
  assert.deepEqual(qbittorrentJobState({ state: 'metaDL', progress: 0 }).message, 'Fetching torrent metadata')
  assert.equal(qbittorrentJobState({ state: 'downloading', progress: 0.426 }).progress, 42)
  assert.equal(qbittorrentJobState({ state: 'stalledDL', progress: 0.5 }).message, 'Waiting for peers')
  assert.equal(qbittorrentJobState({ state: 'pausedDL', progress: 0.5 }).status, 'queued')
  assert.equal(qbittorrentJobState({ state: 'error', progress: 0.5 }).status, 'failed')
  for (const state of ['uploading', 'stalledUP', 'pausedUP', 'stoppedUP']) {
    assert.deepEqual({ ...qbittorrentJobState({ state, progress: 1, content_path: '/downloads/Flood' }), details: undefined }, { status: 'completed', progress: 100, completedPath: '/downloads/Flood', details: undefined })
  }
  // checkingUP after a recheck is not complete until it settles.
  assert.equal(qbittorrentJobState({ state: 'checkingUP', progress: 1 }).status, 'downloading')
  const oversized = qbittorrentJobState({ state: 'downloading', progress: 0.1, total_size: 5000 }, { maxBytes: 4000 })
  assert.equal(oversized.status, 'failed')
  assert.equal(oversized.remove, true)
})

test('transfer details report speed, seeds, peers and a known ETA only', () => {
  const details = torrentTransferDetails({ dlspeed: 2_400_000, upspeed: 12_000, num_seeds: 12, num_complete: 40, num_leechs: 3, num_incomplete: 9, eta: 245, total_size: 1_100_000_000, downloaded: 412_000_000 })
  assert.deepEqual(details, { downloadSpeed: 2_400_000, uploadSpeed: 12_000, seeds: 12, seedsInSwarm: 40, peers: 3, peersInSwarm: 9, eta: 245, size: 1_100_000_000, downloaded: 412_000_000 })
  assert.equal(torrentTransferDetails({ eta: 8640000 }).eta, null)
  assert.equal(qbittorrentJobState({ state: 'downloading', progress: 0.2, dlspeed: 100 }).details.downloadSpeed, 100)
})

function fakeQbittorrent({ preferencesStatus = 200 } = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body, cookie: init.headers?.cookie || null })
    if (url.pathname === '/api/v2/auth/login') return body.password === 'secret' ? new Response('Ok.', { headers: { 'set-cookie': 'SID=abc123; HttpOnly; path=/' } }) : new Response('Fails.')
    if (url.pathname === '/api/v2/torrents/createCategory') return new Response('', { status: 409 })
    if (url.pathname === '/api/v2/torrents/add') return new Response('Ok.')
    if (url.pathname === '/api/v2/torrents/info') return Response.json([{ hash: 'other', tags: 'tomify-other' }, { hash, tags: 'music, tomify-job-1', state: 'downloading', progress: 0.5 }])
    if (url.pathname === '/api/v2/torrents/delete') return new Response('')
    if (url.pathname === '/api/v2/app/setPreferences') return new Response('', { status: preferencesStatus })
    return new Response('', { status: 404 })
  }
  return { calls, fetchImpl }
}

test('the qBittorrent client logs in, adds by tag into its category and finds the torrent by that tag', async () => {
  const qbt = fakeQbittorrent()
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }, qbt.fetchImpl)
  assert.deepEqual(await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomify-job-1', savePath: '/srv/torrents' }), { downloader: 'qbittorrent', remoteId: 'tomify-job-1' })
  const add = qbt.calls.find((call) => call.path === '/api/v2/torrents/add')
  assert.deepEqual(add.body, { urls: `magnet:?xt=urn:btih:${hash}`, category: 'tomify', tags: 'tomify-job-1', savepath: '/srv/torrents' })
  assert.equal(add.cookie, 'SID=abc123')
  assert.equal((await client.info('tomify-job-1')).hash, hash)
  assert.equal(qbt.calls.find((call) => call.path === '/api/v2/torrents/info').query.tag, 'tomify-job-1')
  await client.remove(hash, true)
  assert.deepEqual(qbt.calls.at(-1).body, { hashes: hash, deleteFiles: 'true' })
  const wrong = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'nope', category: 'tomify' }, qbt.fetchImpl)
  await assert.rejects(wrong.info('x'), /rejected the configured username or password/)
})

test('the qBittorrent client sets the download queue limits on the first add only', async () => {
  const qbt = fakeQbittorrent()
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify', maxActiveDownloads: 5 }, qbt.fetchImpl)
  await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomify-job-1', savePath: '/srv/torrents' })
  await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomify-job-2', savePath: '/srv/torrents' })
  const preferences = qbt.calls.filter((call) => call.path === '/api/v2/app/setPreferences')
  assert.equal(preferences.length, 1)
  assert.deepEqual(JSON.parse(preferences[0].body.json), { queueing_enabled: true, max_active_downloads: 5, max_active_uploads: 5, max_active_torrents: 10 })
  assert.equal(preferences[0].cookie, 'SID=abc123')
  assert.ok(qbt.calls.findIndex((call) => call.path === '/api/v2/app/setPreferences') < qbt.calls.findIndex((call) => call.path === '/api/v2/torrents/add'))
})

test('a failed queue-limit update does not stop the torrent being added and is retried next time', async () => {
  const qbt = fakeQbittorrent({ preferencesStatus: 500 })
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }, qbt.fetchImpl)
  assert.equal((await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomify-job-1', savePath: '/srv/torrents' })).remoteId, 'tomify-job-1')
  await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomify-job-2', savePath: '/srv/torrents' })
  assert.equal(qbt.calls.filter((call) => call.path === '/api/v2/app/setPreferences').length, 2)
  assert.equal(qbt.calls.filter((call) => call.path === '/api/v2/torrents/add').length, 2)
})

test('polling a torrent also applies the queue limits, so torrents queued before an update get them', async () => {
  const qbt = fakeQbittorrent()
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify', maxActiveDownloads: 5 }, qbt.fetchImpl)
  await client.info('tomify-job-1')
  await client.info('tomify-job-1')
  assert.equal(qbt.calls.filter((call) => call.path === '/api/v2/app/setPreferences').length, 1)
})

test('only first archive volumes are extracted', () => {
  assert.deepEqual(['a.zip', 'b.rar', 'c.7z', 'd.part1.rar', 'd.part2.rar', 'e.7z.001', 'e.7z.002', 'f.r00', 'g.flac'].filter(isExtractableArchive), ['a.zip', 'b.rar', 'c.7z', 'd.part1.rar', 'e.7z.001'])
})

test('archive listings with traversal, absolute paths, symlinks or too much data are refused', () => {
  const entry = (path, size = 10, attributes = 'A_ -rw-r--r--') => `Path = ${path}\nSize = ${size}\nAttributes = ${attributes}\n`
  assert.equal(checkArchiveListing([entry('Flood/01.flac'), entry('Flood/02.flac')].join('\n'), 100).totalBytes, 20)
  assert.throws(() => checkArchiveListing(entry('../evil.flac'), 100), /unsafe path/)
  assert.throws(() => checkArchiveListing(entry('ok\\..\\..\\evil.flac'), 100), /unsafe path/)
  assert.throws(() => checkArchiveListing(entry('/etc/cron.d/x'), 100), /unsafe path/)
  assert.throws(() => checkArchiveListing(entry('link', 11, ' lrwxrwxrwx'), 100), /symbolic link/)
  assert.throws(() => checkArchiveListing(entry('big.flac', 101), 100), /TOMIFY_TORRENT_MAX_BYTES/)
})

const sevenZip = spawnSync('7z', ['i'], { stdio: 'ignore' }).status === 0
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) return Promise.reject(result.error)
  return result.status === 0 ? Promise.resolve({ stdout: result.stdout, stderr: result.stderr }) : Promise.reject(new Error(result.stderr))
}

test('archives in a completed torrent are extracted into a separate folder', { skip: !sevenZip && '7z is not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-torrent-test-'))
  const download = join(root, 'download')
  await mkdir(join(download, 'Flood'), { recursive: true })
  await writeFile(join(download, 'Flood', '01 - Theme from Flood.flac'), 'audio')
  await run('7z', ['a', join(download, 'Flood', 'Flood.zip'), join(download, 'Flood', '01 - Theme from Flood.flac')])
  const archives = await findArchives(download)
  assert.deepEqual(archives, [join(download, 'Flood', 'Flood.zip')])
  const extracted = await extractArchives(archives, join(root, 'extracted'), { run, maxBytes: 1024 })
  assert.deepEqual(extracted, [join(root, 'extracted', '001')])
  assert.deepEqual(await readdir(extracted[0]), ['01 - Theme from Flood.flac'])
  await assert.rejects(extractArchives(archives, join(root, 'missing'), { run, sevenZip: join(root, 'no-such-7z'), maxBytes: 1024 }), /7-Zip is not installed/)
})

test('torrent search keeps only seeded results with safe links, best-seeded first', () => {
  const other = 'fedcba9876543210fedcba9876543210fedcba98'
  const results = [
    { fileName: 'Flood (1990) MP3', fileUrl: `magnet:?xt=urn:btih:${other}&dn=Flood`, fileSize: 90_000_000, nbSeeders: 3, nbLeechers: 1, siteUrl: 'https://www.limetorrents.lol', descrLink: 'https://www.limetorrents.lol/flood' },
    { fileName: 'Flood (1990) FLAC', fileUrl: `magnet:?xt=urn:btih:${hash}&dn=Flood&tr=https%3A%2F%2Ftracker.test%2Fannounce`, fileSize: 400_000_000, nbSeeders: 42, nbLeechers: 5, siteUrl: 'https://thepiratebay.org', descrLink: 'https://thepiratebay.org/description.php?id=1' },
    { fileName: 'Flood dead', fileUrl: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111', nbSeeders: 0, nbLeechers: 9 },
    { fileName: 'Flood unknown', fileUrl: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222', nbSeeders: -1 },
    { fileName: 'Flood local', fileUrl: 'http://192.168.1.4/flood.torrent', nbSeeders: 50 },
    { fileName: 'Flood duplicate', fileUrl: `magnet:?xt=urn:btih:${hash.toUpperCase()}`, nbSeeders: 10 },
  ]
  const candidates = torrentSearchCandidates(results, { artist: 'They Might Be Giants', album: 'Flood', title: '' }, ['artist', 'album'])
  assert.deepEqual(candidates.map((candidate) => candidate.title), ['Flood (1990) FLAC', 'Flood (1990) MP3'])
  const [best] = candidates
  assert.equal(best.url, 'https://thepiratebay.org/description.php?id=1')
  assert.equal(best.channel, 'thepiratebay.org')
  assert.equal(best.externalId, torrentCandidate(`magnet:?xt=urn:btih:${hash}`, {}).externalId)
  assert.deepEqual({ providerId: best.provenance.providerId, seeds: best.provenance.seeds, peers: best.provenance.peers, size: best.provenance.size, searchMode: best.provenance.searchMode, searchFields: best.provenance.searchFields }, { providerId: 'qbittorrent-search', seeds: 42, peers: 5, size: 400_000_000, searchMode: 'release', searchFields: ['artist', 'album'] })
  assert.match(best.provenance.link, /tracker\.test/)
  assert.equal(candidates[1].channel, 'limetorrents.lol')
})

function fakeSearch({ connection = 'connected', plugins = [{ name: 'piratebay', enabled: true }], statuses = ['Running', 'Stopped'], results = [] } = {}) {
  const calls = []
  let polls = 0
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    if (url.pathname === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc123; path=/' } })
    if (url.pathname === '/api/v2/transfer/info') return Response.json({ connection_status: connection })
    if (url.pathname === '/api/v2/search/plugins') return Response.json(plugins)
    if (url.pathname === '/api/v2/search/start') return Response.json({ id: 7 })
    if (url.pathname === '/api/v2/search/status') return Response.json([{ id: 7, status: statuses[Math.min(polls++, statuses.length - 1)], total: results.length }])
    if (url.pathname === '/api/v2/search/results') return Response.json({ results, status: 'Stopped', total: results.length })
    if (url.pathname === '/api/v2/search/stop' || url.pathname === '/api/v2/search/delete') return new Response('')
    return new Response('', { status: 404 })
  }
  return { calls, fetchImpl }
}

const searchConfig = { url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }

test('qBittorrent search runs the enabled plugins in the music category, waits for them and cleans up', async () => {
  const results = [{ fileName: 'Flood', fileUrl: `magnet:?xt=urn:btih:${hash}`, nbSeeders: 4 }]
  const qbt = fakeSearch({ results })
  const sleeps = []
  const found = await createQbittorrentClient(searchConfig, qbt.fetchImpl).search('They Might Be Giants Flood', { sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(found, results)
  assert.deepEqual(qbt.calls.find((call) => call.path === '/api/v2/search/start').body, { pattern: 'They Might Be Giants Flood', plugins: 'enabled', category: 'music' })
  assert.equal(qbt.calls.filter((call) => call.path === '/api/v2/search/status').length, 2)
  assert.equal(sleeps.length, 1)
  assert.deepEqual(qbt.calls.slice(-2).map((call) => [call.path, call.body.id]), [['/api/v2/search/stop', '7'], ['/api/v2/search/delete', '7']])
})

test('qBittorrent search stops at its time limit and returns what it has', async () => {
  const qbt = fakeSearch({ statuses: ['Running'], results: [] })
  assert.deepEqual(await createQbittorrentClient(searchConfig, qbt.fetchImpl).search('Flood', { timeoutMs: 0 }), [])
  assert.ok(qbt.calls.some((call) => call.path === '/api/v2/search/delete'))
})

test('qBittorrent search refuses to run while offline or without plugins', async () => {
  const offline = fakeSearch({ connection: 'disconnected' })
  await assert.rejects(createQbittorrentClient(searchConfig, offline.fetchImpl).search('Flood'), /NordVPN is connected/)
  assert.equal(offline.calls.some((call) => call.path === '/api/v2/search/start'), false)
  const noPlugins = fakeSearch({ plugins: [{ name: 'piratebay', enabled: false }] })
  await assert.rejects(createQbittorrentClient(searchConfig, noPlugins.fetchImpl).search('Flood'), /No torrent search source is set up/)
})
