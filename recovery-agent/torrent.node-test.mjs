import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkArchiveListing, createQbittorrentClient, extractArchives, findArchives, isExtractableArchive, parseTorrentLink, qbittorrentJobState, torrentCandidate, torrentConfig, torrentTransferDetails } from './torrent.mjs'

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
  assert.throws(() => torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://192.168.1.5:8081' }), /HTTPS \(or loopback HTTP\)/)
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

function fakeQbittorrent() {
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
