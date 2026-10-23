import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQbittorrentClient } from './torrent.mjs'
import { createTomifinController, handleTomifinRequest, hostContentPath, qualityFromTitle, tomifinConfig, tomifinTorrentState, validSearchQuery } from './tomifin.mjs'

const hash = '0123456789abcdef0123456789abcdef01234567'
const other = 'fedcba9876543210fedcba9876543210fedcba98'
const env = { TOMIFY_TOMIFIN_FAMILY_DIR: '/media/family', TOMIFY_TOMIFIN_PRIVATE_DIR: '/media/private' }
const config = tomifinConfig(env, { torrentAvailable: true })

// A qBittorrent stand-in: records every call and never touches a real torrent client or the network.
function fakeClient({ searchResults = [], existing = [] } = {}) {
  const calls = []
  const torrents = [...existing]
  return {
    calls, torrents,
    async search(pattern, options) { calls.push(['search', pattern, options]); return searchResults },
    async findByHash(value) { calls.push(['findByHash', value]); return torrents.find((torrent) => torrent.hash === value) || null },
    async add(link, options) {
      calls.push(['add', link, options])
      torrents.push({ hash, name: 'Big Buck Bunny (2008) 1080p', tags: options.tag, category: options.category, state: 'metaDL', progress: 0, downloaded: 0, content_path: '' })
      return { downloader: 'qbittorrent', remoteId: options.tag }
    },
    async info(value) { calls.push(['info', value]); return torrents.find((torrent) => torrent.tags.split(',').includes(value)) || null },
    async list(category) { calls.push(['list', category]); return torrents.filter((torrent) => torrent.category === category) },
    async pause(value) { calls.push(['pause', value]) },
    async resume(value) { calls.push(['resume', value]) },
    async remove(value, deleteFiles) { calls.push(['remove', value, deleteFiles]); const index = torrents.findIndex((torrent) => torrent.hash === value); if (index >= 0) torrents.splice(index, 1) },
  }
}

const searchResults = [
  { fileName: 'Big Buck Bunny (2008) 1080p BluRay x264', fileUrl: `magnet:?xt=urn:btih:${hash}&dn=Big%20Buck%20Bunny&tr=https%3A%2F%2Ftracker.test%2Fpasskey%2Fannounce`, fileSize: 1_500_000_000, nbSeeders: 40, nbLeechers: 3, siteUrl: 'https://yts.test', descrLink: 'https://yts.test/big-buck-bunny' },
  { fileName: 'Big Buck Bunny 2160p WEB-DL HDR HEVC', fileUrl: 'https://files.example.com/bbb.torrent?passkey=secret', fileSize: 9_000_000_000, nbSeeders: 12, nbLeechers: 8, siteName: 'Example' },
  { fileName: 'Dead torrent', fileUrl: `magnet:?xt=urn:btih:${other}`, nbSeeders: 0 },
  { fileName: 'Local link', fileUrl: 'http://192.168.1.10/a.torrent', nbSeeders: 99 },
  { fileName: 'Not a torrent', fileUrl: 'https://example.com/movie.mkv', nbSeeders: 5 },
]

async function controllerWith(client, options = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'tomifin-'))
  let ids = 0
  const controller = createTomifinController({ config, client, stateRoot, randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, pathExists: async () => false, ...options })
  return { controller, stateRoot }
}

test('Tomifin needs both library folders, kept apart from each other and from Recovery', () => {
  assert.equal(config.enabled, true)
  assert.deepEqual(config.destinations.family, { id: 'family', label: 'Family', category: 'tomifin-family', hostPath: '/media/family', qbittorrentPath: '/media/family' })
  assert.equal(config.destinations.private.hostPath, '/media/private')
  assert.match(tomifinConfig({}, { torrentAvailable: true }).problem, /TOMIFY_TOMIFIN_FAMILY_DIR/)
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_PRIVATE_DIR: '/media/family/private' }, { torrentAvailable: true }).problem, /must be separate/)
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_PRIVATE_DIR: '/media/family' }, { torrentAvailable: true }).problem, /must be separate/)
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_DIR: 'media/family' }, { torrentAvailable: true }).problem, /absolute path/)
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_DIR: '/' }, { torrentAvailable: true }).problem, /filesystem root/)
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_DIR: '/srv/music/films' }, { torrentAvailable: true, reservedPaths: ['/srv/music'] }).problem, /separate from \/srv\/music/)
  assert.match(tomifinConfig(env, { torrentAvailable: false }).problem, /needs qBittorrent/)
  const mapped = tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR: '/data/family', TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR: '/data/private' }, { torrentAvailable: true })
  assert.deepEqual([mapped.destinations.family.qbittorrentPath, mapped.destinations.private.qbittorrentPath], ['/data/family', '/data/private'])
  assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR: '/data', TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR: '/data/private' }, { torrentAvailable: true }).problem, /must be separate/)
})

test('search queries are trimmed and bounded', () => {
  assert.equal(validSearchQuery('  Big\u0000 Buck\n Bunny '), 'Big Buck Bunny')
  assert.throws(() => validSearchQuery('a'), /at least two/)
  assert.throws(() => validSearchQuery('x'.repeat(201)), /too long/)
})

test('quality hints come from the release name', () => {
  assert.deepEqual(qualityFromTitle('Movie.2019.2160p.UHD.BluRay.REMUX.HDR.HEVC'), { resolution: '2160p', hdr: 'HDR', codec: 'HEVC', source: 'Remux' })
  assert.deepEqual(qualityFromTitle('Show S01E01 720p WEB-DL x264'), { resolution: '720p', hdr: null, codec: 'H.264', source: 'WEB-DL' })
  assert.deepEqual(qualityFromTitle('Something'), { resolution: null, hdr: null, codec: null, source: null })
})

test('search uses qBittorrent plugins and indexers for films and TV, and never returns a link', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const found = await controller.search({ query: 'Big Buck Bunny' })
  assert.deepEqual(client.calls[0], ['search', 'Big Buck Bunny', { category: 'all', indexerCategories: '2000,5000' }])
  assert.deepEqual(found.results.map((result) => result.title), ['Big Buck Bunny (2008) 1080p BluRay x264', 'Big Buck Bunny 2160p WEB-DL HDR HEVC'])
  const [best, second] = found.results
  assert.deepEqual({ source: best.source, size: best.size, seeders: best.seeders, leechers: best.leechers, type: best.type, linkType: best.linkType, detailsUrl: best.detailsUrl }, { source: 'yts.test', size: 1_500_000_000, seeders: 40, leechers: 3, type: 'torrent', linkType: 'magnet', detailsUrl: 'https://yts.test/big-buck-bunny' })
  assert.equal(second.linkType, 'torrent-file')
  assert.equal(best.quality.resolution, '1080p')
  assert.match(best.id, /^[a-f0-9]{64}$/)
  const serialised = JSON.stringify(found)
  assert.doesNotMatch(serialised, /passkey|magnet:|secret|tracker\.test/)
  await controller.search({ query: 'Big Buck Bunny', kind: 'tv' })
  assert.deepEqual(client.calls[1][2], { category: 'tv', indexerCategories: '5000' })
  await assert.rejects(controller.search({ query: 'Big Buck Bunny', kind: 'music' }), /films, TV or both/)
})

test('a download needs Family or Private and a result from this agent\'s own search', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  for (const destination of [undefined, '', 'public', '/media/family', '../private', 'FAMILY/..']) {
    await assert.rejects(controller.download({ resultId: best.id, destination }), /Choose Family or Private/, String(destination))
  }
  await assert.rejects(controller.download({ resultId: 'magnet:?xt=urn:btih:' + hash, destination: 'family' }), /Choose a search result/)
  await assert.rejects(controller.download({ resultId: 'a'.repeat(64), destination: 'family' }), /expired/)
  assert.equal(client.calls.some(([name]) => name === 'add'), false)
  // A path or link sent alongside is ignored: the folder comes from the agent's settings, the link from its search.
  await controller.download({ resultId: best.id, destination: 'family', savePath: '/etc', link: 'http://127.0.0.1:8081/api/v2/app/shutdown' })
  const add = client.calls.find(([name]) => name === 'add')
  assert.equal(add[2].savePath, '/media/family')
  assert.match(add[1], /^magnet:\?xt=urn:btih:0123/)
})

test('Family and Private downloads go to their own qBittorrent folder and category', async () => {
  for (const [destination, path, category] of [['family', '/media/family', 'tomifin-family'], ['private', '/media/private', 'tomifin-private']]) {
    const client = fakeClient({ searchResults })
    const { controller, stateRoot } = await controllerWith(client)
    const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
    const { job } = await controller.download({ resultId: best.id, destination })
    const add = client.calls.find(([name]) => name === 'add')
    assert.match(add[1], /^magnet:\?xt=urn:btih:0123/)
    assert.deepEqual(add[2], { tag: `tomifin-${job.id}`, savePath: path, category, subfolder: true })
    assert.equal(job.destination, destination)
    assert.equal(job.status, 'queued')
    const saved = JSON.parse(await readFile(join(stateRoot, 'tomifin', `${job.id}.json`), 'utf8'))
    assert.equal(saved.destination, destination)
    assert.doesNotMatch(JSON.stringify(saved), /passkey|tracker\.test/)
    // Recovery's job runner only reads job files at the top of the state folder, so it never sees Tomifin's.
    assert.deepEqual((await readdir(stateRoot)).filter((name) => name.endsWith('.json')), [])
    await assert.rejects(controller.download({ resultId: best.id, destination }), /expired/, 'a result is used once')
  }
})

test('qBittorrent\'s own path is used when it sees the libraries at a different place', async () => {
  const mapped = tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR: '/data/family', TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR: '/data/private' }, { torrentAvailable: true })
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client, { config: mapped })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await controller.download({ resultId: best.id, destination: 'private' })
  assert.equal(client.calls.find(([name]) => name === 'add')[2].savePath, '/data/private')
  assert.equal(hostContentPath('/data/private/Big Buck Bunny', mapped.destinations.private), '/media/private/Big Buck Bunny')
  assert.equal(hostContentPath('/data/family/Big Buck Bunny', mapped.destinations.private), null)
  assert.equal(hostContentPath('/data/private', mapped.destinations.private), null)
  assert.equal(hostContentPath('/data/private/../family/x', mapped.destinations.private), null)
})

test('a torrent already in qBittorrent is refused rather than taken over', async () => {
  const client = fakeClient({ searchResults, existing: [{ hash, tags: 'tomify-recovery-job', category: 'tomify', state: 'downloading' }] })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await assert.rejects(controller.download({ resultId: best.id, destination: 'family' }), /already in qBittorrent/)
  assert.equal(client.calls.some(([name]) => name === 'add'), false)
})

test('a failed qBittorrent add is reported and nothing is saved', async () => {
  const client = fakeClient({ searchResults })
  client.add = async () => { throw new Error('qBittorrent refused the torrent link (it may already be in qBittorrent).') }
  const { controller, stateRoot } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await assert.rejects(controller.download({ resultId: best.id, destination: 'family' }), /refused the torrent/)
  assert.deepEqual(await readdir(join(stateRoot, 'tomifin')).catch(() => []), [])
})

test('qBittorrent states map to queued, downloading, stalled, paused, completed and failed', () => {
  const now = Date.parse('2026-10-23T12:00:00Z')
  assert.equal(tomifinTorrentState(null, { createdAt: '2026-10-23T11:59:30Z', now }).status, 'queued')
  assert.equal(tomifinTorrentState(null, { createdAt: '2026-10-23T11:00:00Z', now }).status, 'failed')
  assert.equal(tomifinTorrentState({ state: 'downloading', progress: 0.5 }).status, 'downloading')
  assert.equal(tomifinTorrentState({ state: 'stalledDL', progress: 0.5 }).status, 'stalled')
  assert.equal(tomifinTorrentState({ state: 'queuedDL' }).status, 'queued')
  assert.equal(tomifinTorrentState({ state: 'stoppedDL' }).status, 'paused')
  assert.equal(tomifinTorrentState({ state: 'pausedDL' }).status, 'paused')
  assert.equal(tomifinTorrentState({ state: 'uploading', progress: 1 }).status, 'completed')
  assert.equal(tomifinTorrentState({ state: 'stoppedUP', progress: 1 }).status, 'completed')
  assert.equal(tomifinTorrentState({ state: 'error' }).status, 'failed')
  assert.equal(tomifinTorrentState({ state: 'missingFiles' }).status, 'failed')
  assert.equal(tomifinTorrentState({ state: 'downloading', total_size: 10 }, { maxBytes: 5 }).status, 'failed')
})

test('the downloads list shows progress, speed, sizes and ETA for Tomifin jobs only', async () => {
  const client = fakeClient({ searchResults, existing: [{ hash: other, tags: 'tomify-x', category: 'tomify', state: 'downloading' }] })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'private' })
  Object.assign(client.torrents.find((torrent) => torrent.hash === hash), { state: 'downloading', progress: 0.4237, dlspeed: 2_500_000, completed: 635_550_000, total_size: 1_500_000_000, eta: 345, content_path: '/media/private/Big Buck Bunny', downloaded: 635_550_000 })
  const { jobs } = await controller.list()
  assert.equal(jobs.length, 1)
  assert.deepEqual(
    { id: jobs[0].id, name: jobs[0].name, destination: jobs[0].destination, destinationLabel: jobs[0].destinationLabel, status: jobs[0].status, progress: jobs[0].progress, downloadSpeed: jobs[0].downloadSpeed, downloaded: jobs[0].downloaded, size: jobs[0].size, eta: jobs[0].eta, canPause: jobs[0].canPause, canResume: jobs[0].canResume },
    { id: job.id, name: 'Big Buck Bunny (2008) 1080p', destination: 'private', destinationLabel: 'Private', status: 'downloading', progress: 42.3, downloadSpeed: 2_500_000, downloaded: 635_550_000, size: 1_500_000_000, eta: 345, canPause: true, canResume: false },
  )
  assert.deepEqual(client.calls.filter(([name]) => name === 'list').map(([, category]) => category), ['tomifin-private'])
})

test('pause and resume act only on the job\'s own torrent', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  assert.equal((await controller.pause({ id: job.id })).job.status, 'paused')
  assert.equal((await controller.resume({ id: job.id })).job.status, 'queued')
  assert.deepEqual(client.calls.filter(([name]) => ['pause', 'resume'].includes(name)), [['pause', hash], ['resume', hash]])
  await assert.rejects(controller.pause({ id: '../../etc/passwd' }), /Unknown download/)
  await assert.rejects(controller.pause({ id: '00000000-0000-4000-8000-999999999999' }), /no longer listed/)
})

test('cancelling deletes partial data only when the download started from nothing', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  Object.assign(client.torrents[0], { state: 'downloading', content_path: '/media/family/Big Buck Bunny', progress: 0, downloaded: 0 })
  await controller.observe()
  Object.assign(client.torrents[0], { progress: 0.3, downloaded: 400 })
  assert.equal((await controller.list()).jobs[0].keepsFilesOnCancel, false)
  assert.deepEqual(await controller.cancel({ id: job.id }), { cancelled: true, filesDeleted: true, torrentRemoved: true })
  assert.deepEqual(client.calls.find(([name]) => name === 'remove'), ['remove', hash, true])
  assert.deepEqual((await controller.list()).jobs, [])
})

test('cancelling never deletes files that were already in the library, or a finished download', async () => {
  const cases = [
    { name: 'existing files', exists: true, torrent: { state: 'checkingDL', content_path: '/media/family/Big Buck Bunny', progress: 0, downloaded: 0 } },
    { name: 'checked late', exists: false, torrent: { state: 'downloading', content_path: '/media/family/Big Buck Bunny', progress: 0.2, downloaded: 10 } },
    { name: 'outside the library', exists: false, torrent: { state: 'downloading', content_path: '/srv/music/Big Buck Bunny', progress: 0, downloaded: 0 } },
    { name: 'the library folder itself', exists: false, torrent: { state: 'downloading', content_path: '/media/family', progress: 0, downloaded: 0 } },
    { name: 'unreadable library', exists: 'error', torrent: { state: 'downloading', content_path: '/media/family/Big Buck Bunny', progress: 0, downloaded: 0 } },
    { name: 'finished', exists: false, finishAfterCheck: true, torrent: { state: 'downloading', content_path: '/media/family/Big Buck Bunny', progress: 0, downloaded: 0 } },
  ]
  for (const entry of cases) {
    const client = fakeClient({ searchResults })
    const { controller } = await controllerWith(client, { pathExists: async () => { if (entry.exists === 'error') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return entry.exists } })
    const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
    const { job } = await controller.download({ resultId: best.id, destination: 'family' })
    Object.assign(client.torrents[0], entry.torrent)
    await controller.observe()
    if (entry.finishAfterCheck) Object.assign(client.torrents[0], { state: 'uploading', progress: 1 })
    const result = await controller.cancel({ id: job.id })
    assert.equal(result.filesDeleted, false, entry.name)
    assert.deepEqual(client.calls.find(([name]) => name === 'remove'), ['remove', hash, false], entry.name)
  }
})

test('the agent routes report Tomifin errors as JSON and ignore other paths', async () => {
  const { controller } = await controllerWith(fakeClient({ searchResults }))
  assert.equal(await handleTomifinRequest('/v1/status', {}, controller), null)
  assert.equal(await handleTomifinRequest('/v1/tomifin/../status', {}, controller), null)
  assert.deepEqual((await handleTomifinRequest('/v1/tomifin/status', {}, controller)).body.destinations.map(({ id, available }) => [id, available]), [['family', true], ['private', true]])
  const refused = await handleTomifinRequest('/v1/tomifin/download', { resultId: 'x', destination: 'family' }, controller)
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'invalid-result')
  const off = createTomifinController({ config: tomifinConfig({}, { torrentAvailable: true }), client: null, stateRoot: tmpdir() })
  const unavailable = await handleTomifinRequest('/v1/tomifin/search', { query: 'Big Buck Bunny' }, off)
  assert.equal(unavailable.body.code, 'not-configured')
  assert.equal(off.status().available, false)
})

test('the qBittorrent client lists a category, pauses with the 5.x names and falls back to the 4.x ones', async () => {
  const calls = []
  let modern = true
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null })
    if (url.pathname === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } })
    if (url.pathname === '/api/v2/torrents/info') return Response.json([{ hash, category: 'tomifin-family' }, { hash: other, category: 'tomify' }])
    if (url.pathname === '/api/v2/torrents/stop' || url.pathname === '/api/v2/torrents/start') return new Response('', { status: modern ? 200 : 404 })
    if (url.pathname === '/api/v2/torrents/pause' || url.pathname === '/api/v2/torrents/resume') return new Response('')
    if (url.pathname === '/api/v2/torrents/createCategory') return new Response('', { status: 409 })
    if (url.pathname === '/api/v2/torrents/add') return new Response('Ok.')
    return new Response('', { status: 200 })
  }
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }, fetchImpl)
  assert.deepEqual((await client.list('tomifin-family')).map((torrent) => torrent.hash), [hash])
  assert.equal(calls.find((call) => call.path === '/api/v2/torrents/info').query.category, 'tomifin-family')
  await client.pause(hash)
  modern = false
  await client.resume(hash)
  assert.deepEqual(calls.filter((call) => /stop|start|pause|resume/.test(call.path)).map((call) => call.path), ['/api/v2/torrents/stop', '/api/v2/torrents/start', '/api/v2/torrents/resume'])
  await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomifin-1', savePath: '/media/family', category: 'tomifin-family', subfolder: true })
  assert.deepEqual(calls.find((call) => call.path === '/api/v2/torrents/createCategory').body, { category: 'tomifin-family', savePath: '/media/family' })
  assert.deepEqual(calls.find((call) => call.path === '/api/v2/torrents/add').body, { urls: `magnet:?xt=urn:btih:${hash}`, category: 'tomifin-family', tags: 'tomifin-1', savepath: '/media/family', contentLayout: 'Subfolder', root_folder: 'true' })
})
