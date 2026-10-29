import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQbittorrentClient, safeDetailsUrl } from './torrent.mjs'
import { JellyfinAuthError } from './jellyfin.mjs'
import { UNCONFIRMED_KEEP_MS, createTomifinController, handleTomifinRequest, hostContentPath, partialDataDeletable, stagingPath, qualityFromTitle, tomifinConfig, tomifinTorrentState, torrentRetryable, validSearchQuery } from './tomifin.mjs'

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
    connectionStatus: 'connected',
    async connection() { calls.push(['connection']); if (this.connectionStatus instanceof Error) throw this.connectionStatus; return this.connectionStatus },
    async search(pattern, options) { calls.push(['search', pattern, options]); return searchResults },
    async findByHash(value) { calls.push(['findByHash', value]); return torrents.find((torrent) => torrent.hash === value) || null },
    async add(link, options) {
      calls.push(['add', link, options])
      torrents.push({ hash, name: 'Big Buck Bunny (2008) 1080p', tags: options.tag, category: options.category, state: 'metaDL', progress: 0, downloaded: 0, content_path: '' })
      return { downloader: 'qbittorrent', remoteId: options.tag }
    },
    async info(value) { calls.push(['info', value]); return torrents.find((torrent) => torrent.tags.split(',').includes(value)) || null },
    async list(category) { calls.push(['list', category]); return torrents.filter((torrent) => torrent.category === category) },
    async pause(value) { calls.push(['pause', value]); const torrent = torrents.find((entry) => entry.hash === value); if (torrent) torrent.state = 'stoppedDL' },
    async resume(value) { calls.push(['resume', value]) },
    async recheck(value) { calls.push(['recheck', value]) },
    trackerList: [], propertiesValue: { is_private: false },
    async trackers(value) { calls.push(['trackers', value]); return this.trackerList },
    async properties(value) { calls.push(['properties', value]); return this.propertiesValue },
    async addTrackers(value, urls) { calls.push(['addTrackers', value, urls]) },
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
  const controller = createTomifinController({ config, client, stateRoot, randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, ...options })
  return { controller, stateRoot }
}

test('Tomifin needs both library folders, kept apart from each other and from Recovery', () => {
  assert.equal(config.enabled, true)
  assert.deepEqual(config.destinations.family, { id: 'family', label: 'Family', category: 'tomifin-family', hostPath: '/media/family', qbittorrentPath: '/media/family', saveQbittorrentPath: '/media/family', imports: false })
  for (const bad of ['downloads', '../x', '.a/b', '.', '..']) assert.match(tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR: bad }, { torrentAvailable: true }).problem, /hidden folder name/, bad)
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
    assert.deepEqual(add[2], { tag: `tomifin-${job.id}`, savePath: path, downloadPath: `${path}/.tomifin-incomplete/${job.id}`, category, subfolder: true })
    assert.equal(job.destination, destination)
    assert.equal(job.status, 'queued')
    const saved = JSON.parse(await readFile(join(stateRoot, 'tomifin', `${job.id}.json`), 'utf8'))
    assert.equal(saved.destination, destination)
    assert.doesNotMatch(JSON.stringify(saved), /passkey|tracker\.test/)
    // Recovery's job runner only reads job files at the top of the state folder, so it never sees Tomifin's.
    assert.deepEqual((await readdir(stateRoot)).filter((name) => name.endsWith('.json')), [])
    await assert.rejects(controller.download({ resultId: best.id, destination }), /expired|already/, 'a result is used once')
  }
})

test('qBittorrent\'s own path is used when it sees the libraries at a different place', async () => {
  const mapped = tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR: '/data/family', TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR: '/data/private' }, { torrentAvailable: true })
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client, { config: mapped })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await controller.download({ resultId: best.id, destination: 'private' })
  assert.equal(client.calls.find(([name]) => name === 'add')[2].savePath, '/data/private')
  assert.match(client.calls.find(([name]) => name === 'add')[2].downloadPath, /^\/data\/private\/\.tomifin-incomplete\/[0-9a-f-]{36}$/)
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
  client.add = async () => { throw Object.assign(new Error('qBittorrent refused the torrent link (it may already be in qBittorrent).'), { rejected: true }) }
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
  assert.deepEqual(client.calls.filter(([name]) => name === 'list').map(([, category]) => category).sort(), ['tomifin-family', 'tomifin-private'])
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

test('a failed torrent can be retried: qBittorrent rechecks and restarts it, in its own folders only', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  const staging = `/media/family/.tomifin-incomplete/${job.id}`
  Object.assign(client.torrents[0], { state: 'downloading', save_path: '/media/family/', download_path: staging, content_path: `${staging}/Big Buck Bunny`, progress: 0.4 })
  assert.equal((await controller.list()).jobs[0].canRetry, false, 'a healthy torrent offers no retry')
  await assert.rejects(controller.retry({ id: job.id }), { code: 'not-retryable' })
  for (const state of ['error', 'missingFiles']) {
    client.torrents[0].state = state
    const [view] = (await controller.list()).jobs
    assert.deepEqual([view.status, view.canRetry, view.canResume], ['failed', true, false], state)
    const retried = await controller.retry({ id: job.id })
    assert.deepEqual([retried.job.status, retried.job.message], ['downloading', 'Checking files'])
  }
  assert.deepEqual(client.calls.filter(([name]) => ['recheck', 'resume', 'remove'].includes(name)), [['recheck', hash], ['resume', hash], ['recheck', hash], ['resume', hash]])
  // A torrent qBittorrent keeps anywhere outside its library is never restarted.
  client.calls.length = 0
  for (const outside of [{ save_path: '/srv/other' }, { download_path: '/tmp/x' }, { content_path: '/media/private/Big Buck Bunny' }, { save_path: '' }, { save_path: '/media/family/../etc' }]) {
    Object.assign(client.torrents[0], { state: 'error', save_path: '/media/family', download_path: staging, content_path: `${staging}/Big Buck Bunny`, ...outside })
    assert.equal((await controller.list()).jobs[0].canRetry, false, JSON.stringify(outside))
    await assert.rejects(controller.retry({ id: job.id }), /outside its library folder/, JSON.stringify(outside))
  }
  assert.equal(client.calls.some(([name]) => ['recheck', 'resume'].includes(name)), false)
  await assert.rejects(controller.retry({ id: '../../etc/passwd' }), /Unknown download/)
})

test('torrents missing from qBittorrent or over the size limit cannot be retried', async () => {
  const destination = config.destinations.family
  assert.equal(torrentRetryable(null, destination), false)
  assert.equal(torrentRetryable({ state: 'error', save_path: '/media/family', total_size: 10 }, destination, 5), false)
  assert.equal(torrentRetryable({ state: 'error', save_path: '/media/family', total_size: 10 }, destination, 50), true)
  assert.equal(torrentRetryable({ state: 'stalledDL', save_path: '/media/family' }, destination), false)
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  client.torrents.length = 0
  await assert.rejects(controller.retry({ id: job.id }), /no longer in qBittorrent/)
})

test('cancelling deletes partial data only while it is still in the job\'s own staging folder', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  const staging = `/media/family/.tomifin-incomplete/${job.id}`
  Object.assign(client.torrents[0], { state: 'downloading', content_path: `${staging}/Big Buck Bunny`, download_path: staging, progress: 0.3, downloaded: 400 })
  assert.equal((await controller.list()).jobs[0].keepsFilesOnCancel, false)
  assert.deepEqual(await controller.cancel({ id: job.id }), { cancelled: true, filesDeleted: true, torrentRemoved: true })
  assert.deepEqual(client.calls.find(([name]) => name === 'remove'), ['remove', hash, true])
  assert.deepEqual((await controller.list()).jobs, [])
})

test('cancelling never deletes anything in the library, a finished download or another job\'s folder', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const staging = `/media/family/.tomifin-incomplete/${id}`
  const cases = [
    { name: 'saved straight into the library (older qBittorrent)', torrent: { state: 'downloading', content_path: '/media/family/Big Buck Bunny', progress: 0.2 } },
    { name: 'finished and moved', torrent: { state: 'uploading', content_path: '/media/family/Big Buck Bunny', progress: 1 } },
    { name: 'finished, still in staging', torrent: { state: 'stalledUP', content_path: `${staging}/Big Buck Bunny`, progress: 1 } },
    { name: 'being moved into the library', torrent: { state: 'moving', content_path: `${staging}/Big Buck Bunny`, progress: 0.99 } },
    { name: 'another job\'s staging folder', torrent: { state: 'downloading', content_path: '/media/family/.tomifin-incomplete/00000000-0000-4000-8000-000000000009/Big Buck Bunny', progress: 0.2 } },
    { name: 'the staging folder itself', torrent: { state: 'downloading', content_path: staging, progress: 0.2 } },
    { name: 'escaping the staging folder', torrent: { state: 'downloading', content_path: `${staging}/../../Big Buck Bunny`, progress: 0.2 } },
    { name: 'download path moved elsewhere', torrent: { state: 'downloading', content_path: `${staging}/Big Buck Bunny`, download_path: '/media/family', progress: 0.2 } },
    { name: 'outside the library', torrent: { state: 'downloading', content_path: '/srv/music/Big Buck Bunny', progress: 0.2 } },
  ]
  for (const entry of cases) {
    const client = fakeClient({ searchResults })
    const { controller } = await controllerWith(client)
    const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
    const { job } = await controller.download({ resultId: best.id, destination: 'family' })
    assert.equal(job.id, id)
    Object.assign(client.torrents[0], entry.torrent)
    assert.equal((await controller.list()).jobs[0].keepsFilesOnCancel, true, entry.name)
    const result = await controller.cancel({ id: job.id })
    assert.equal(result.filesDeleted, false, entry.name)
    assert.deepEqual(client.calls.find(([name]) => name === 'remove'), ['remove', hash, false], entry.name)
  }
  assert.equal(stagingPath(config.destinations.private, id), `/media/private/.tomifin-incomplete/${id}`)
  assert.equal(partialDataDeletable(null, config.destinations.family, id), false)
})

test('a job record is written before qBittorrent is asked, and nothing is added if it cannot be written', async () => {
  const client = fakeClient({ searchResults })
  const blocked = join(await mkdtemp(join(tmpdir(), 'tomifin-')), 'not-a-folder')
  await writeFile(blocked, '')
  const { controller } = await controllerWith(client, { stateRoot: blocked })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await assert.rejects(controller.download({ resultId: best.id, destination: 'family' }))
  assert.equal(client.calls.some(([name]) => name === 'add'), false)

  // The record already exists when qBittorrent is called.
  const watched = fakeClient({ searchResults })
  const { controller: second, stateRoot } = await controllerWith(watched)
  const add = watched.add.bind(watched)
  watched.add = async (link, options) => { assert.equal((await readdir(join(stateRoot, 'tomifin'))).length, 1); return add(link, options) }
  const { results: [again] } = await second.search({ query: 'Big Buck Bunny' })
  await second.download({ resultId: again.id, destination: 'family' })
})

test('an add that fails but reached qBittorrent keeps its record; one that did not is rolled back', async () => {
  const client = fakeClient({ searchResults })
  const add = client.add.bind(client)
  client.add = async (link, options) => { await add(link, options); throw new Error('qBittorrent add timed out.') }
  const { controller, stateRoot } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  assert.deepEqual(await readdir(join(stateRoot, 'tomifin')), [`${job.id}.json`])
  assert.equal((await controller.list()).jobs.length, 1)

  const refusing = fakeClient({ searchResults })
  refusing.add = async () => { throw Object.assign(new Error('qBittorrent refused the torrent link (it may already be in qBittorrent).'), { rejected: true }) }
  const { controller: other, stateRoot: otherRoot } = await controllerWith(refusing)
  const { results: [again] } = await other.search({ query: 'Big Buck Bunny' })
  await assert.rejects(other.download({ resultId: again.id, destination: 'family' }), /refused the torrent/)
  assert.deepEqual(await readdir(join(otherRoot, 'tomifin')), [])
})

test('an add whose answer was lost keeps its record until the torrent shows up, and is dropped if it never does', async () => {
  for (const appears of [true, false]) {
    let clock = Date.parse('2026-10-23T12:00:00Z')
    const client = fakeClient({ searchResults })
    const add = client.add.bind(client)
    let hidden = null
    // qBittorrent takes the torrent (or not) but the answer never arrives, and it is not listed straight away.
    client.add = async (link, options) => { if (appears) { await add(link, options); hidden = client.torrents.pop() } throw new Error('The operation was aborted due to timeout') }
    const { controller, stateRoot } = await controllerWith(client, { now: () => clock })
    const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
    await assert.rejects(controller.download({ resultId: best.id, destination: 'family' }), (error) => error.code === 'unconfirmed')
    assert.equal((await readdir(join(stateRoot, 'tomifin'))).length, 1, 'record kept')
    const [waiting] = (await controller.list()).jobs
    assert.deepEqual([waiting.status, waiting.message, waiting.keepsFilesOnCancel], ['queued', 'Waiting for qBittorrent to confirm', true])
    const { results: [again] } = await controller.search({ query: 'Big Buck Bunny' })
    await assert.rejects(controller.download({ resultId: again.id, destination: 'family' }), /already in your downloads/, 'not queued twice while unconfirmed')
    clock += 5 * 60_000
    if (appears) client.torrents.push(hidden)
    await controller.observe()
    if (appears) {
      const saved = JSON.parse(await readFile(join(stateRoot, 'tomifin', `${waiting.id}.json`), 'utf8'))
      assert.equal(saved.unconfirmedSince, undefined)
      assert.equal((await controller.list()).jobs[0].message, 'Fetching torrent details')
      clock += UNCONFIRMED_KEEP_MS * 2
      await controller.observe()
      assert.equal((await controller.list()).jobs.length, 1, 'a confirmed download is never dropped')
    } else {
      assert.equal((await controller.list()).jobs.length, 1, 'still waiting')
      clock += UNCONFIRMED_KEEP_MS
      await controller.observe()
      assert.deepEqual((await controller.list()).jobs, [])
      assert.deepEqual(await readdir(join(stateRoot, 'tomifin')), [])
    }
    assert.equal(client.calls.some(([name]) => name === 'remove'), false)
  }
})

test('the qBittorrent client marks a definite refusal, and leaves a lost answer unmarked', async () => {
  let answer = () => new Response('Ok.')
  const fetchImpl = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } })
    if (path === '/api/v2/torrents/add') return answer()
    return new Response('', { status: 200 })
  }
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }, fetchImpl)
  const options = { tag: 'tomifin-1', savePath: '/media/family', category: 'tomifin-family' }
  for (const [name, reply, rejected] of [['refused', () => new Response('Fails.'), true], ['error status', () => new Response('', { status: 415 }), true], ['timeout', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, undefined]]) {
    answer = reply
    await assert.rejects(client.add(`magnet:?xt=urn:btih:${hash}`, options), (error) => error.rejected === rejected, name)
  }
})

test('a double click or retry cannot add the same torrent twice', async () => {
  const client = fakeClient({ searchResults: searchResults.slice(1, 2) })
  let release = () => {}
  let entered = () => {}
  const adding = new Promise((resolve) => { entered = resolve })
  const add = client.add.bind(client)
  client.add = async (link, options) => { const wait = new Promise((resolve) => { release = resolve }); entered(); await wait; return add(link, options) }
  const { controller } = await controllerWith(client)
  const { results: [torrentFile] } = await controller.search({ query: 'Big Buck Bunny' })
  assert.equal(torrentFile.linkType, 'torrent-file')
  const first = controller.download({ resultId: torrentFile.id, destination: 'family' })
  await adding
  await assert.rejects(controller.download({ resultId: torrentFile.id, destination: 'family' }), /already being queued/)
  release()
  await first
  // Searching again gives the same result id; it is refused because it is already in the downloads.
  const { results: [repeat] } = await controller.search({ query: 'Big Buck Bunny' })
  await assert.rejects(controller.download({ resultId: repeat.id, destination: 'private' }), /already in your downloads/)
  assert.equal(client.calls.filter(([name]) => name === 'add').length, 1)
})

test('a Tomifin torrent with no record is tracked again, and its files are never deleted on cancel', async () => {
  const lost = '00000000-0000-4000-8000-0000000000aa'
  const client = fakeClient({ existing: [
    { hash, name: 'Sintel 1080p', tags: `tomifin-${lost}`, category: 'tomifin-private', state: 'downloading', progress: 0.5, content_path: `/media/private/.tomifin-incomplete/${lost}/Sintel` },
    { hash: other, name: 'Recovery album', tags: 'tomify-job', category: 'tomify', state: 'downloading' },
  ] })
  const { controller, stateRoot } = await controllerWith(client)
  await controller.observe()
  assert.deepEqual(await readdir(join(stateRoot, 'tomifin')), [`${lost}.json`])
  const { jobs } = await controller.list()
  assert.deepEqual(jobs.map(({ id, name, destination, keepsFilesOnCancel }) => ({ id, name, destination, keepsFilesOnCancel })), [{ id: lost, name: 'Sintel 1080p', destination: 'private', keepsFilesOnCancel: true }])
  assert.equal((await controller.cancel({ id: lost })).filesDeleted, false)
  assert.deepEqual(client.calls.find(([name]) => name === 'remove'), ['remove', hash, false])
})

test('a magnet that turns out larger than the limit once its details arrive is stopped and cannot be resumed', async () => {
  const client = fakeClient({ searchResults: [{ ...searchResults[0], fileSize: -1 }] })
  const { controller } = await controllerWith(client, { config: { ...config, maxBytes: 5_000_000_000 } })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  assert.equal(best.size, null)
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  await controller.observe()
  assert.equal(client.calls.some(([name]) => name === 'pause'), false, 'size still unknown while fetching details')
  Object.assign(client.torrents[0], { state: 'downloading', total_size: 9_000_000_000, size: 9_000_000_000 })
  await controller.observe()
  assert.deepEqual(client.calls.filter(([name]) => name === 'pause'), [['pause', hash]])
  assert.equal(client.torrents[0].state, 'stoppedDL')
  const [view] = (await controller.list()).jobs
  assert.deepEqual([view.status, view.canResume, view.canPause], ['failed', false, false])
  assert.match(view.message, /larger than the download limit/)
  await assert.rejects(controller.resume({ id: job.id }), /cannot be resumed/)
  assert.equal(client.calls.some(([name]) => name === 'resume'), false)
  await controller.observe()
  assert.equal(client.calls.filter(([name]) => name === 'pause').length, 1, 'stopped once')
})

test('a finished download is taken out of qBittorrent once its files are in the library, and the files are kept', async () => {
  const client = fakeClient({ searchResults })
  const { controller, stateRoot } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  const staging = `/media/family/.tomifin-incomplete/${job.id}`
  // Finished but still in staging, or being moved: left alone.
  for (const torrent of [{ state: 'uploading', progress: 1, content_path: `${staging}/Big Buck Bunny` }, { state: 'moving', progress: 1, content_path: `${staging}/Big Buck Bunny` }, { state: 'downloading', progress: 0.9, content_path: '/media/family/Big Buck Bunny' }]) {
    Object.assign(client.torrents[0], torrent)
    await controller.observe()
    assert.equal(client.calls.some(([name]) => name === 'remove'), false, torrent.state)
  }
  Object.assign(client.torrents[0], { state: 'stalledUP', progress: 1, content_path: '/media/family/Big Buck Bunny', total_size: 1_500_000_000 })
  await controller.observe()
  assert.deepEqual(client.calls.filter(([name]) => name === 'remove'), [['remove', hash, false]])
  assert.equal(client.torrents.length, 0)
  const saved = JSON.parse(await readFile(join(stateRoot, 'tomifin', `${job.id}.json`), 'utf8'))
  assert.match(saved.completedAt, /^\d{4}-/)
  const [view] = (await controller.list()).jobs
  assert.deepEqual([view.status, view.progress, view.size, view.keepsFilesOnCancel, view.canPause], ['completed', 100, 1_500_000_000, true, false])
  assert.deepEqual(await controller.cancel({ id: job.id }), { cancelled: true, filesDeleted: false, torrentRemoved: false })
  assert.deepEqual((await controller.list()).jobs, [])
})

test('a finished torrent qBittorrent will not remove is tried again', async () => {
  const client = fakeClient({ searchResults })
  let failures = 1
  const remove = client.remove.bind(client)
  client.remove = async (value, deleteFiles) => { if (failures-- > 0) throw new Error('qBittorrent delete returned HTTP 500.'); return remove(value, deleteFiles) }
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  await controller.download({ resultId: best.id, destination: 'family' })
  Object.assign(client.torrents[0], { state: 'uploading', progress: 1, content_path: '/media/family/Big Buck Bunny' })
  await controller.observe()
  assert.equal(client.torrents.length, 1)
  assert.equal((await controller.list()).jobs[0].status, 'completed')
  assert.equal(client.torrents.length, 0)
  assert.deepEqual(client.calls.filter(([name]) => name === 'remove'), [['remove', hash, false]])
})

test('with the Family importer, Family torrents are saved in .downloads and keep seeding; Private is unchanged', async () => {
  const importing = tomifinConfig({ ...env, TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR: '.downloads' }, { torrentAvailable: true })
  assert.deepEqual([importing.destinations.family.saveQbittorrentPath, importing.destinations.family.imports, importing.destinations.private.imports], ['/media/family/.downloads', true, false])
  for (const [destination, savePath, removed] of [['family', '/media/family/.downloads', false], ['private', '/media/private', true]]) {
    const client = fakeClient({ searchResults })
    const { controller } = await controllerWith(client, { config: importing })
    const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
    const { job } = await controller.download({ resultId: best.id, destination })
    const add = client.calls.find(([name]) => name === 'add')[2]
    assert.deepEqual([add.savePath, add.downloadPath], [savePath, `${savePath}/.tomifin-incomplete/${job.id}`], destination)
    Object.assign(client.torrents[0], { state: 'stalledUP', progress: 1, content_path: `${savePath}/Big Buck Bunny` })
    await controller.observe()
    assert.equal(client.calls.some(([name]) => name === 'remove'), removed, destination)
    if (!removed) {
      const [view] = (await controller.list()).jobs
      assert.deepEqual([view.status, view.message, view.keepsFilesOnCancel], ['completed', 'Seeding; the Family importer adds it to the library', true])
    }
  }
})

test('the VPN status combines qBittorrent\'s connection with NordVPN\'s, without addresses', async () => {
  const nord = (extra) => async () => ({ control: 'enabled', state: 'connected', server: 'uk2012.nordvpn.com', country: 'United Kingdom', city: 'London', ip: '203.0.113.7', technology: 'NORDLYNX', ...extra })
  const cases = [
    ['connected', null, { state: 'connected', nordvpn: null }],
    ['connected', nord(), { state: 'connected', nordvpn: { state: 'connected', country: 'United Kingdom', city: 'London', server: 'uk2012.nordvpn.com' } }],
    ['firewalled', nord(), { state: 'connected' }],
    ['disconnected', nord(), { state: 'down' }],
    ['connected', nord({ state: 'disconnected' }), { state: 'down' }],
    ['unknown', nord({ state: 'connecting' }), { state: 'connecting' }],
    [new Error('qBittorrent is down'), null, { state: 'unknown', qbittorrent: 'unknown' }],
    ['connected', async () => ({ control: 'disabled', state: 'unknown' }), { state: 'connected', nordvpn: null }],
    ['connected', async () => ({ control: 'enabled', state: 'unavailable', message: 'NordVPN did not answer.' }), { state: 'connected', nordvpn: null }],
    ['connected', async () => { throw new Error('nordvpn missing') }, { state: 'connected', nordvpn: null }],
  ]
  for (const [connection, vpnStatus, expected] of cases) {
    const client = fakeClient()
    client.connectionStatus = connection
    const { controller } = await controllerWith(client, { vpnStatus })
    const result = await controller.vpn()
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${connection} ${key}`)
    assert.doesNotMatch(JSON.stringify(result), /203\.0\.113|NORDLYNX/)
  }
  const route = await handleTomifinRequest('/v1/tomifin/vpn', { session: 'good-session-token' }, (await controllerWith(fakeClient())).controller, fakeAuth)
  assert.deepEqual(route, { status: 200, body: { state: 'connected', qbittorrent: 'connected', nordvpn: null } })
  assert.equal((await handleTomifinRequest('/v1/tomifin/vpn', {}, (await controllerWith(fakeClient())).controller, fakeAuth)).body.code, 'unauthorized')
})

test('details links never carry credentials or point at private hosts', () => {
  assert.equal(safeDetailsUrl('https://yts.test/movies/big-buck-bunny-2008'), 'https://yts.test/movies/big-buck-bunny-2008')
  assert.equal(safeDetailsUrl('https://tracker.test/details.php?id=12345'), 'https://tracker.test/details.php?id=12345')
  assert.equal(safeDetailsUrl('https://tracker.test/details.php?id=12345&apikey=FAKEKEY123&passkey=abc&torrent_pass=x&sid=1#top'), 'https://tracker.test/details.php?id=12345')
  assert.equal(safeDetailsUrl('https://tracker.test/details?id=7&t=0f1e2d3c4b5a69788796a5b4c3d2e1f0'), 'https://tracker.test/details?id=7')
  assert.equal(safeDetailsUrl('https://tracker.test/details?q=Zx9Kq2LmP4vN8rT1yW6bH3jF'), 'https://tracker.test/details')
  assert.equal(safeDetailsUrl('https://tracker.test/rss/0f1e2d3c4b5a69788796a5b4c3d2e1f0/details/1'), null)
  assert.equal(safeDetailsUrl('https://user:pass@tracker.test/details/1'), null)
  assert.equal(safeDetailsUrl('http://192.168.1.20:9696/details/1'), null)
  assert.equal(safeDetailsUrl('http://localhost:9117/details/1'), null)
  assert.equal(safeDetailsUrl('javascript:alert(1)'), null)
  assert.equal(safeDetailsUrl(''), null)
})

test('search results show a cleaned details link', async () => {
  const client = fakeClient({ searchResults: [{ ...searchResults[0], descrLink: 'https://tracker.test/details.php?id=9&apikey=FAKEKEY123456' }] })
  const { controller } = await controllerWith(client)
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  assert.equal(best.detailsUrl, 'https://tracker.test/details.php?id=9')
  assert.doesNotMatch(JSON.stringify(best), /FAKEKEY/)
})

// A Jellyfin sign-in stand-in: the session 'good-session-token' belongs to an administrator.
const fakeAuth = {
  async login() { return { token: 'good-session-token', user: { name: 'tom' } } },
  async logout() { return { signedOut: true } },
  async verify(session) {
    if (session !== 'good-session-token') throw new JellyfinAuthError('unauthorized', 'Sign in with your Jellyfin account.')
    return { name: 'tom', isAdmin: true }
  },
}

test('the agent routes need a Jellyfin session, report Tomifin errors as JSON and ignore other paths', async () => {
  const { controller } = await controllerWith(fakeClient({ searchResults }))
  const session = 'good-session-token'
  const call = (path, body = {}, target = controller) => handleTomifinRequest(path, body, target, fakeAuth)
  assert.equal(await call('/v1/status'), null)
  assert.equal(await call('/v1/tomifin/../status'), null)
  const denied = await call('/v1/tomifin/status', { session: 'someone-else-token' })
  assert.deepEqual([denied.status, denied.body.code], [400, 'unauthorized'])
  assert.equal((await call('/v1/tomifin/downloads')).body.code, 'unauthorized')
  assert.deepEqual((await call('/v1/tomifin/login', { username: 'tom', password: 'x' })).body, { token: session, user: { name: 'tom' } })
  assert.deepEqual((await call('/v1/tomifin/session', { session })).body, { user: { name: 'tom' } })
  assert.deepEqual((await call('/v1/tomifin/status', { session })).body.destinations.map(({ id, available }) => [id, available]), [['family', true], ['private', true]])
  const refused = await call('/v1/tomifin/download', { session, resultId: 'x', destination: 'family' })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'invalid-result')
  const off = createTomifinController({ config: tomifinConfig({}, { torrentAvailable: true }), client: null, stateRoot: tmpdir() })
  const unavailable = await call('/v1/tomifin/search', { session, query: 'Big Buck Bunny' }, off)
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
    if (url.pathname === '/api/v2/transfer/info') return Response.json({ connection_status: 'firewalled' })
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
  await client.recheck(hash)
  assert.deepEqual(calls.filter((call) => call.path === '/api/v2/torrents/recheck').map((call) => call.body), [{ hashes: hash }])
  assert.equal(await client.connection(), 'firewalled')
  await client.add(`magnet:?xt=urn:btih:${hash}`, { tag: 'tomifin-1', savePath: '/media/family', category: 'tomifin-family', subfolder: true })
  assert.deepEqual(calls.find((call) => call.path === '/api/v2/torrents/createCategory').body, { category: 'tomifin-family', savePath: '/media/family' })
  assert.deepEqual(calls.find((call) => call.path === '/api/v2/torrents/add').body, { urls: `magnet:?xt=urn:btih:${hash}`, category: 'tomifin-family', tags: 'tomifin-1', savepath: '/media/family', contentLayout: 'Subfolder', root_folder: 'true' })
})

// ---------------------------------------------------------------------------------------------------------------
// Add link: pasted magnets and .torrent files become normal qBittorrent jobs.

function bencodeValue(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return bencodeValue(Buffer.from(value))
  if (Number.isInteger(value)) return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencodeValue), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap((key) => [bencodeValue(key), bencodeValue(value[key])]), Buffer.from('e')])
}
const linkedTorrent = bencodeValue({ announce: 'https://tracker.test/PASSKEY123456/announce', info: { length: 1_000_000, name: 'Sintel.2010.1080p.mkv', 'piece length': 262144, pieces: Buffer.alloc(80, 7) } })
const linkedMagnet = `magnet:?xt=urn:btih:${hash}&dn=Sintel%202010&tr=https%3A%2F%2Ftracker.test%2FPASSKEY123456%2Fannounce`

test('a pasted magnet is checked, shown without its trackers, and queued in qBittorrent for the chosen library', async () => {
  for (const [destination, category] of [['family', 'tomifin-family'], ['private', 'tomifin-private']]) {
    const logs = []
    const client = fakeClient()
    const { controller, stateRoot } = await controllerWith(client, { log: (line) => logs.push(line) })
    const checked = await controller.link({ link: `  ${linkedMagnet}  ` })
    assert.equal(checked.detected, 'magnet')
    assert.deepEqual([checked.result.type, checked.result.linkType, checked.result.title, checked.result.source], ['torrent', 'magnet', 'Sintel 2010', 'Added link'])
    assert.match(checked.result.id, /^[a-f0-9]{64}$/)
    assert.ok(!/PASSKEY|tracker\.test|magnet:/.test(JSON.stringify(checked)), 'no link, trackers or passkeys go back to the browser')
    const queued = await controller.download({ resultId: checked.result.id, destination })
    assert.equal(queued.job.destination, destination)
    const add = client.calls.find((call) => call[0] === 'add')
    assert.equal(add[1], linkedMagnet)
    assert.equal(add[2].category, category)
    assert.equal(add[2].tag, 'tomifin-00000000-0000-4000-8000-000000000001')
    const record = JSON.parse(await readFile(join(stateRoot, 'tomifin', '00000000-0000-4000-8000-000000000001.json'), 'utf8'))
    assert.deepEqual([record.downloader, record.origin, record.infoHash], ['qbittorrent', 'link', hash])
    assert.ok(!/PASSKEY|magnet:/.test(JSON.stringify(record)), 'the record keeps no link or trackers')
    assert.ok(!/PASSKEY|tracker\.test|magnet:|Sintel/.test(logs.join('\n')), 'the logs name no link, tracker or title')
    await assert.rejects(controller.link({ link: linkedMagnet }), { code: 'duplicate' })
  }
})

test('an uploaded or linked .torrent file is checked here and uploaded to qBittorrent as bytes', async () => {
  const client = fakeClient()
  const fetched = []
  const fetchLink = async (url) => { fetched.push(url); return { bytes: linkedTorrent } }
  const { controller } = await controllerWith(client, { fetchLink })
  const checked = await controller.link({ link: 'https://files.test/download.php?id=1' })
  assert.deepEqual([checked.detected, checked.result.linkType, checked.result.title, checked.result.size], ['torrent', 'torrent-file', 'Sintel.2010.1080p.mkv', 1_000_000])
  assert.ok(!/PASSKEY|files\.test/.test(JSON.stringify(checked)))
  await controller.download({ resultId: checked.result.id, destination: 'family' })
  const add = client.calls.find((call) => call[0] === 'add')
  assert.equal(add[1], null, 'no link is passed on: qBittorrent gets the checked file')
  assert.ok(Buffer.from(add[2].torrent).equals(linkedTorrent))
  assert.deepEqual(fetched, ['https://files.test/download.php?id=1'])
  const upload = await controllerWith(fakeClient())
  const viaFile = await upload.controller.link({ file: { name: 'renamed.nzb', data: linkedTorrent.toString('base64') } })
  assert.equal(viaFile.detected, 'torrent', 'the content decides, not the file name')
})

test('bad links, oversized torrents and qBittorrent failures are reported without adding twice', async () => {
  const { controller } = await controllerWith(fakeClient())
  for (const link of ['magnet:?xt=urn:btih:1234', 'magnet:?dn=x', 'ftp://files.test/a.torrent', 'https://user:pass@files.test/a.torrent', 'not a link']) {
    await assert.rejects(controller.link({ link }), (error) => ['invalid-link', 'unsafe-link'].includes(error.code), link)
  }
  await assert.rejects(controller.link({}), { code: 'invalid-link' })
  await assert.rejects(controller.link({ link: linkedMagnet, file: { name: 'a.torrent', data: linkedTorrent.toString('base64') } }), { code: 'invalid-link' })
  const small = await controllerWith(fakeClient(), { config: tomifinConfig({ ...env, TOMIFY_TOMIFIN_MAX_BYTES: '1000' }, { torrentAvailable: true }) })
  await assert.rejects(small.controller.link({ file: { name: 'a.torrent', data: linkedTorrent.toString('base64') } }), { code: 'too-large' })
  const off = await controllerWith(fakeClient())
  await assert.rejects(off.controller.link({ file: { name: 'a.nzb', data: Buffer.from('<nzb><file subject="a"><groups><group>a.b</group></groups><segments><segment bytes="1" number="1">a@b</segment></segments></file></nzb>').toString('base64') } }), { code: 'usenet-unavailable' })

  const refusing = fakeClient()
  refusing.add = async () => { throw Object.assign(new Error('qBittorrent refused the torrent link.'), { rejected: true }) }
  const refused = await controllerWith(refusing)
  const checked = await refused.controller.link({ link: linkedMagnet })
  await assert.rejects(refused.controller.download({ resultId: checked.result.id, destination: 'private' }), /refused/)
  assert.deepEqual(await readdir(join(refused.stateRoot, 'tomifin')), [])

  const lost = fakeClient()
  lost.add = async () => { throw new Error('qBittorrent could not be reached.') }
  const unsure = await controllerWith(lost)
  const again = await unsure.controller.link({ link: linkedMagnet })
  await assert.rejects(unsure.controller.download({ resultId: again.result.id, destination: 'family' }), { code: 'unconfirmed' })
  await assert.rejects(unsure.controller.link({ link: linkedMagnet }), { code: 'duplicate' }, 'an unconfirmed link cannot be added again')
})

test('the agent route for Add link needs a session', async () => {
  const { controller } = await controllerWith(fakeClient())
  const signedOut = await handleTomifinRequest('/v1/tomifin/link', { link: linkedMagnet }, controller, fakeAuth)
  assert.equal(signedOut.body.code, 'unauthorized')
  const signedIn = await handleTomifinRequest('/v1/tomifin/link', { session: 'good-session-token', link: linkedMagnet }, controller, fakeAuth)
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.body.detected, 'magnet')
  const bad = await handleTomifinRequest('/v1/tomifin/link', { session: 'good-session-token', link: 'magnet:?xt=urn:btih:zz' }, controller, fakeAuth)
  assert.deepEqual([bad.status, bad.body.code], [400, 'invalid-link'])
})

test('More trackers adds trackers found by info hash and from public lists, never to a private torrent', async () => {
  const client = fakeClient({ searchResults })
  let listCalls = 0
  const publicTrackers = async () => { listCalls += 1; return { trackers: ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.demonii.com:1337/announce', 'udp://10.0.0.1:80/announce'], failed: 0, lists: 2 } }
  const { controller } = await controllerWith(client, { publicTrackers })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  client.torrents[0].state = 'stalledDL'
  assert.equal((await controller.list()).jobs[0].canFindTrackers, true)
  client.trackerList = [{ url: '** [DHT] **', msg: '' }, { url: 'udp://open.demonii.com:1337/announce/', msg: '' }]
  const hashResults = [
    { fileName: 'Same', fileUrl: `magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Fexodus.desync.com%3A6969&tr=http%3A%2F%2Fuser%3Apw%40t.test%2Fa`, nbSeeders: 2 },
    { fileName: 'Other', fileUrl: `magnet:?xt=urn:btih:${other}&tr=udp%3A%2F%2Fwrong.test%3A1`, nbSeeders: 9 },
  ]
  client.search = async (pattern, options) => { client.calls.push(['search', pattern, options]); return hashResults }
  const outcome = await controller.trackers({ id: job.id })
  assert.deepEqual([outcome.added, outcome.fromSearch, outcome.fromLists], [2, 1, 1])
  assert.deepEqual(client.calls.find(([name]) => name === 'addTrackers'), ['addTrackers', hash, ['udp://exodus.desync.com:6969', 'udp://tracker.opentrackr.org:1337/announce']])
  assert.equal(client.calls.filter(([name]) => name === 'search').at(-1)[1], hash, 'the search is by info hash')
  assert.equal(listCalls, 1)

  // A private torrent: refused, by any of qBittorrent's signs, and nothing is added.
  for (const sign of [{ torrent: { private: true } }, { properties: { is_private: true } }, { trackers: [{ url: '** [PeX] **', msg: 'This torrent is private' }] }]) {
    client.calls.length = 0
    client.torrents[0].private = sign.torrent?.private
    client.propertiesValue = sign.properties || { is_private: false }
    client.trackerList = sign.trackers || []
    if (sign.torrent) assert.equal((await controller.list()).jobs[0].canFindTrackers, false)
    await assert.rejects(controller.trackers({ id: job.id }), { code: 'private-torrent' }, JSON.stringify(sign))
    assert.equal(client.calls.some(([name]) => ['addTrackers', 'search'].includes(name)), false)
  }
  await assert.rejects(controller.trackers({ id: '../../etc/passwd' }), /Unknown download/)
})

test('More trackers with nothing new adds nothing, and says when the lookups failed', async () => {
  const client = fakeClient({ searchResults })
  const { controller } = await controllerWith(client, { publicTrackers: async () => ({ trackers: [], failed: 2, lists: 2 }) })
  const { results: [best] } = await controller.search({ query: 'Big Buck Bunny' })
  const { job } = await controller.download({ resultId: best.id, destination: 'family' })
  client.search = async () => []
  const outcome = await controller.trackers({ id: job.id })
  assert.equal(outcome.added, 0)
  assert.deepEqual(outcome.warnings, ['The public tracker lists could not be fetched.'])
  assert.equal(client.calls.some(([name]) => name === 'addTrackers'), false)
  client.search = async () => { throw new Error('qBittorrent is offline') }
  await assert.rejects(controller.trackers({ id: job.id }), { code: 'trackers-unavailable' })
})
