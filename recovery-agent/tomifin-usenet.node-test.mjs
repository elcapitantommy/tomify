import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTomifinController, tomifinConfig } from './tomifin.mjs'
import { DEFAULT_SABNZBD_CATEGORIES, createTomifinUsenet, publishRetryDelay, sabHistoryState, sabQueueState, sabTimeLeft, tomifinUsenetConfig } from './tomifin-usenet.mjs'
import { createSabnzbdClient, parseNewznabVideoResults } from './usenet.mjs'

const INDEXER_KEY = 'INDEXERSECRETKEY123'
const SAB_KEY = 'SABSECRETKEY456'
const indexers = [{ id: 'geek', name: 'NZBgeek', url: 'https://api.nzbgeek.test', apiKey: INDEXER_KEY }]
// Recovery's NZBIndex settings (nzbIndexConfig), pointed at a fake host. Anonymous unless a key is set.
const NZBINDEX = { type: 'nzbindex', id: 'nzbindex', name: 'NZBIndex', apiKey: '', apiUrl: 'https://api.nzbindex.test', siteUrl: 'https://www.nzbindex.test' }
const NZBINDEX_KEY = 'NZBINDEXSECRET789'
const collection = (id, name, size = 2_000_000_000, extra = {}) => ({ id, name, size, posted: Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000), complete: true, fileCount: 40, poster: 'p@example.test', groups: ['alt.binaries.movies'], ...extra })
const sabDownloader = { type: 'sabnzbd', url: 'http://127.0.0.1:8080', apiKey: SAB_KEY, category: 'tomify-music' }
const film = 'x'.repeat(3000)
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const nzb = (tag = 'abc', name = 'Sintel 2010 1080p') => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head><meta type="name">${name}</meta></head>
<file poster="p@example.test" date="1700000000" subject="&quot;${tag}.part01.rar&quot; yEnc (1/1)"><groups><group>alt.binaries.test</group></groups>
<segments><segment bytes="700000" number="1">${tag}-1@news.test</segment><segment bytes="300000" number="2">${tag}-2@news.test</segment></segments></file></nzb>`)

const newznabXml = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>${items.map(({ title, guid, size = 2_000_000_000, grabs = 50 }) => `<item><title>${title}</title><guid isPermaLink="true">https://nzbgeek.test/details/${guid}</guid><link>https://api.nzbgeek.test/api?t=get&amp;id=${guid}&amp;apikey=${INDEXER_KEY}</link><comments>https://nzbgeek.test/details/${guid}#comments</comments><pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate><enclosure url="https://api.nzbgeek.test/api?t=get&amp;id=${guid}&amp;apikey=${INDEXER_KEY}" length="${size}" type="application/x-nzb"/><newznab:attr name="size" value="${size}"/><newznab:attr name="grabs" value="${grabs}"/></item>`).join('')}</channel></rss>`

// A SABnzbd stand-in: a queue, a history and its categories, recording every call. No real SABnzbd is involved.
function fakeSab({ categories = ['*', 'tomify-music', 'tomifin-family', 'tomifin-private'] } = {}) {
  const calls = []
  const state = { queue: [], history: [], kbPerSec: 2048, categories, nextAdd: null, unreachable: false }
  let count = 0
  const sab = {
    calls, state,
    async version() { return '4.3.0' },
    async categories() { calls.push(['categories']); if (state.unreachable) throw new Error('down'); return state.categories },
    async addFile(bytes, { name, category }) {
      calls.push(['addFile', name, category, bytes.length])
      const behaviour = state.nextAdd
      state.nextAdd = null
      if (behaviour === 'reject') throw Object.assign(new Error('SABnzbd refused it: duplicate'), { rejected: true })
      const nzoId = `SABnzbd_nzo_${++count}`
      if (behaviour === 'lost') throw Object.assign(new Error('SABnzbd could not be reached.'), { uncertain: true })
      if (behaviour === 'lost-but-added') { state.queue.push({ nzo_id: nzoId, filename: name, cat: category, status: 'Queued', mb: '1', mbleft: '1', percentage: '0', timeleft: '0:00:00' }); throw Object.assign(new Error('SABnzbd could not be reached.'), { uncertain: true }) }
      state.queue.push({ nzo_id: nzoId, filename: name, cat: category, status: 'Downloading', mb: '1000', mbleft: '250', percentage: '75', timeleft: '0:02:05' })
      return { nzoId }
    },
    async queue() { calls.push(['queue']); if (state.unreachable) throw new Error('down'); return { slots: state.queue, kbPerSec: state.kbPerSec, paused: false } },
    async history(category) { calls.push(['history', category]); if (state.unreachable) throw new Error('down'); return state.history.filter((slot) => slot.category === category) },
    async pause(value) { calls.push(['pause', value]); const slot = state.queue.find((entry) => entry.nzo_id === value); if (slot) slot.status = 'Paused' },
    async resume(value) { calls.push(['resume', value]); const slot = state.queue.find((entry) => entry.nzo_id === value); if (slot) slot.status = 'Downloading' },
    async deleteQueued(value, deleteFiles) { calls.push(['deleteQueued', value, deleteFiles]); state.queue = state.queue.filter((entry) => entry.nzo_id !== value) },
    async deleteHistory(value, deleteFiles) { calls.push(['deleteHistory', value, deleteFiles]); state.history = state.history.filter((entry) => entry.nzo_id !== value) },
    // Moves a queued job to history as SABnzbd does once it has downloaded, unpacked and post-processed it.
    async finish(nzoId, root, files, { status = 'Completed', fail = '' } = {}) {
      const slot = state.queue.find((entry) => entry.nzo_id === nzoId)
      state.queue = state.queue.filter((entry) => entry !== slot)
      const storage = join(root, slot.cat, `${status === 'Failed' ? '_FAILED_' : ''}${slot.filename}`)
      await mkdir(storage, { recursive: true })
      for (const [relative, content] of Object.entries(files)) {
        await mkdir(dirname(join(storage, relative)), { recursive: true })
        await writeFile(join(storage, relative), content)
      }
      state.history.push({ nzo_id: nzoId, name: slot.filename, category: slot.cat, status, fail_message: fail, storage, bytes: 1_000_000 })
      return storage
    },
  }
  return sab
}

// A qBittorrent stand-in with no torrents, so the torrent side of the controller keeps working beside Usenet.
function fakeQbittorrent({ searchResults = [] } = {}) {
  const calls = []
  return {
    calls, connectionStatus: 'connected',
    async connection() { return 'connected' },
    async search(pattern) { calls.push(['search', pattern]); return searchResults },
    async findByHash() { return null },
    async add(link, options) { calls.push(['add', link, options]); return { downloader: 'qbittorrent' } },
    async info() { return null },
    async list() { return [] },
    async pause() {}, async resume() {}, async remove() {},
  }
}

async function world({ env = {}, newznab = indexers, nzbIndex = null, nzbIndexJson = null, failing = [], sab = fakeSab(), searchXml = newznabXml([{ title: 'Sintel.2010.1080p.BluRay.x264-GRP', guid: 'g1' }]), nzbFor = () => nzb(), downloader = sabDownloader, qbSearch = [], fetchLink = null, probe = async () => ({ ok: true, duration: 5400 }) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tomifin-usenet-'))
  const family = join(root, 'family')
  const privateLibrary = join(root, 'private')
  const completed = join(root, 'usenet')
  const stateRoot = join(root, 'state')
  for (const folder of [family, privateLibrary, join(completed, 'tomifin-family'), join(completed, 'tomifin-private'), stateRoot]) await mkdir(folder, { recursive: true })
  const tomifin = tomifinConfig({ TOMIFY_TOMIFIN_FAMILY_DIR: family, TOMIFY_TOMIFIN_PRIVATE_DIR: privateLibrary, TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR: '.downloads' }, { torrentAvailable: true })
  const config = tomifinUsenetConfig(env, { indexers: newznab, nzbIndex, downloader, downloadRoot: completed, tomifin })
  const logs = []
  const fetched = []
  const searches = []
  const fetchImpl = async (url) => {
    searches.push(String(url))
    const isNzbIndex = new URL(String(url)).host === 'api.nzbindex.test'
    if (failing.includes(isNzbIndex ? 'nzbindex' : 'newznab')) throw new TypeError('fetch failed')
    return isNzbIndex ? Response.json(nzbIndexJson || { data: { content: [] } }) : new Response(searchXml, { status: 200 })
  }
  const fetchNzb = async (url) => { fetched.push(url); return { bytes: nzbFor(url) } }
  const usenet = createTomifinUsenet({ config, tomifin, stateRoot, sab, fetchImpl, fetchNzb, probe, stableMs: 0, log: (line) => logs.push(line) })
  const qb = fakeQbittorrent({ searchResults: qbSearch })
  let ids = 0
  const controller = createTomifinController({ config: tomifin, client: qb, stateRoot, usenet, fetchLink: fetchLink || (async () => { throw new Error('no network') }), randomId: () => id(++ids), log: (line) => logs.push(line) })
  return { root, family, privateLibrary, completed, stateRoot, tomifin, config, sab, usenet, controller, qb, logs, fetched, searches }
}

async function searchAndQueue(context, destination = 'family', query = 'Sintel') {
  const found = await context.controller.search({ query: query, kind: 'video' })
  const result = found.results.find((entry) => entry.type === 'usenet')
  return { found, result, queued: await context.controller.download({ resultId: result.id, destination }) }
}

async function settle(context) {
  await context.controller.list()
  await context.controller.observe()
  return context.controller.list()
}

async function tree(path) {
  const out = []
  async function walk(folder, prefix) {
    for (const name of (await readdir(folder).catch(() => [])).sort()) {
      const info = await lstat(join(folder, name))
      out.push(prefix + name + (info.isDirectory() ? '/' : ''))
      if (info.isDirectory()) await walk(join(folder, name), `${prefix}${name}/`)
    }
  }
  await walk(path, '')
  return out
}

// ---------------------------------------------------------------------------------------------------------------

test('Usenet settings reuse Recovery\'s indexers and SABnzbd, and stay off with a reason otherwise', async () => {
  const context = await world()
  assert.equal(context.config.available, true)
  assert.deepEqual(context.config.categories, DEFAULT_SABNZBD_CATEGORIES)
  assert.equal(context.config.publish, 'auto')
  assert.equal(context.config.cleanup, false)
  assert.equal(context.config.tvDir, 'TV')
  const tomifin = context.tomifin
  const base = { indexers, downloader: sabDownloader, downloadRoot: context.completed, tomifin }
  const problem = (env, options = {}) => tomifinUsenetConfig(env, { ...base, ...options }).problem
  const noSearch = tomifinUsenetConfig({}, { ...base, indexers: [] })
  assert.equal(noSearch.available, true, 'SABnzbd alone is enough to download added NZBs')
  assert.equal(noSearch.search.available, false)
  assert.match(noSearch.search.problem, /No Usenet search provider/)
  const withNzbIndex = tomifinUsenetConfig({}, { ...base, indexers: [], nzbIndex: NZBINDEX })
  assert.deepEqual([withNzbIndex.search.available, withNzbIndex.search.providers], [true, ['NZBIndex']])
  assert.deepEqual(tomifinUsenetConfig({}, { ...base, nzbIndex: NZBINDEX }).search.providers, ['NZBIndex', 'NZBgeek'])
  assert.match(problem({}, { downloader: null }), /SABnzbd is not configured/)
  assert.match(problem({}, { downloader: { ...sabDownloader, type: 'nzbget' } }), /NZBGet is not supported/)
  assert.match(problem({}, { downloader: { ...sabDownloader, apiKey: '' } }), /API_KEY/)
  assert.match(problem({}, { downloadRoot: null }), /TOMIFY_USENET_DOWNLOAD_DIR/)
  assert.match(problem({}, { downloadRoot: join(context.family, 'usenet') }), /outside the Family and Private/)
  assert.match(problem({}, { downloadRoot: dirname(context.family) }), /outside the Family and Private/)
  assert.match(problem({ TOMIFY_TOMIFIN_SABNZBD_PRIVATE_CATEGORY: 'tomifin-family' }), /different SABnzbd categories/)
  assert.match(problem({ TOMIFY_TOMIFIN_SABNZBD_FAMILY_CATEGORY: 'tomify-music' }), /differ from Recovery/)
  assert.match(problem({ TOMIFY_TOMIFIN_SABNZBD_FAMILY_CATEGORY: '../x' }), /simple names/)
  assert.match(problem({ TOMIFY_TOMIFIN_USENET_PUBLISH: 'move' }), /auto or copy/)
  assert.match(problem({}, { tomifin: { enabled: false, problem: 'Tomifin is off.' } }), /Tomifin is off/)
  assert.equal(tomifinUsenetConfig({ TOMIFY_TOMIFIN_USENET_CLEANUP: 'true', TOMIFY_TOMIFIN_USENET_PUBLISH: 'copy' }, base).cleanup, true)
})

test('SABnzbd states map onto Tomifin\'s', () => {
  assert.equal(sabTimeLeft('1:02:03'), 3723)
  assert.equal(sabTimeLeft('1:00:00:00'), 86400)
  assert.equal(sabTimeLeft('soon'), null)
  assert.equal(sabQueueState({ status: 'Downloading' }).status, 'downloading')
  assert.equal(sabQueueState({ status: 'Queued' }).status, 'queued')
  assert.equal(sabQueueState({ status: 'Propagating' }).status, 'queued')
  assert.equal(sabQueueState({ status: 'Paused' }).status, 'paused')
  assert.deepEqual(sabQueueState({ status: 'Paused', labels: ['ENCRYPTED'] }).code, 'password-protected')
  assert.equal(sabHistoryState({ status: 'Completed' }).status, 'completed')
  assert.equal(sabHistoryState({ status: 'Extracting' }).status, 'post-processing')
  assert.equal(sabHistoryState({ status: 'Verifying' }).status, 'post-processing')
  assert.equal(sabHistoryState({ status: 'Moving' }).status, 'post-processing')
  assert.deepEqual(sabHistoryState({ status: 'Failed', fail_message: 'Unpacking failed, archive requires a password' }).code, 'password-protected')
  assert.deepEqual(sabHistoryState({ status: 'Failed', fail_message: 'Unpacking failed, CRC error' }).code, 'unpack-failed')
  assert.deepEqual(sabHistoryState({ status: 'Failed', fail_message: 'Download failed - Not on your server(s)' }).code, 'download-failed')
  assert.equal(sabHistoryState({ status: 'Completed', fail_message: 'Repair failed' }).status, 'failed', 'a "Completed" job with a failure message is not trusted')
  assert.doesNotMatch(sabHistoryState({ status: 'Failed', fail_message: 'Unpack failed in /srv/usenet/secret/x see https://sab.test/x?apikey=1' }).message, /\/srv|https|apikey/)
})

test('Newznab video results keep their GUIDs but no API key, and SABnzbd uploads keep the key server-side', async () => {
  const parsed = parseNewznabVideoResults(newznabXml([{ title: 'Sintel 2010 1080p', guid: 'g1', grabs: 12 }]), indexers[0], Date.parse('2024-01-11T00:00:00Z'))
  assert.equal(parsed.length, 1)
  assert.deepEqual([parsed[0].guid, parsed[0].size, parsed[0].grabs, parsed[0].ageDays], ['g1', 2_000_000_000, 12, 10])
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(INDEXER_KEY))
  const requests = []
  const client = createSabnzbdClient(sabDownloader, async (url, init) => { requests.push({ url: String(url), init }); return Response.json(String(url).includes('mode=addfile') ? { status: true, nzo_ids: ['SABnzbd_nzo_1'] } : { status: true }) })
  assert.deepEqual(await client.addFile(nzb(), { name: `tomifin-${id(1)}`, category: 'tomifin-family' }), { nzoId: 'SABnzbd_nzo_1' })
  const add = new URL(requests[0].url)
  assert.deepEqual([add.searchParams.get('mode'), add.searchParams.get('nzbname'), add.searchParams.get('cat')], ['addfile', `tomifin-${id(1)}`, 'tomifin-family'])
  assert.equal(requests[0].init.redirect, 'error')
  assert.ok(requests[0].init.body instanceof FormData)
  const refusing = createSabnzbdClient(sabDownloader, async () => Response.json({ status: false, error: 'No category /srv/x' }))
  await assert.rejects(refusing.addFile(nzb(), { name: 'x', category: 'y' }), (error) => error.rejected === true && !/\/srv/.test(error.message))
  const lost = createSabnzbdClient(sabDownloader, async () => { throw new Error('ECONNRESET') })
  await assert.rejects(lost.addFile(nzb(), { name: 'x', category: 'y' }), (error) => error.uncertain === true)
  const broken = createSabnzbdClient(sabDownloader, async () => new Response('oops', { status: 502 }))
  await assert.rejects(broken.addFile(nzb(), { name: 'x', category: 'y' }), (error) => error.uncertain === true, 'a 5xx is not a certain refusal')
})

test('one search returns torrents and NZBs together, with opaque ids and no indexer details', async () => {
  const torrent = { fileName: 'Sintel 2010 720p', fileUrl: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, fileSize: 700_000_000, nbSeeders: 9, nbLeechers: 1, siteUrl: 'https://yts.test' }
  const context = await world({ qbSearch: [torrent], searchXml: newznabXml([{ title: 'Sintel.2010.1080p.BluRay.x264-GRP', guid: 'g1' }, { title: 'Sintel.2010.1080p.BluRay.x264-GRP', guid: 'g1' }, { title: 'Sintel.2010.2160p.WEB-DL', guid: 'g2', size: 9_000_000_000 }]) })
  const found = await context.controller.search({ query: 'Sintel', kind: 'video' })
  assert.equal(found.usenet, true)
  assert.deepEqual(found.results.map((result) => result.type).sort(), ['torrent', 'usenet', 'usenet'], 'the duplicate GUID is shown once')
  const usenet = found.results.find((result) => result.type === 'usenet')
  assert.match(usenet.id, /^[a-f0-9]{64}$/)
  assert.deepEqual([usenet.source, usenet.linkType, usenet.seeders, usenet.leechers, usenet.grabs], ['NZBgeek', 'nzb', null, null, 50])
  assert.equal(usenet.detailsUrl, 'https://nzbgeek.test/details/g1')
  const body = JSON.stringify(found)
  for (const secret of [INDEXER_KEY, 'api.nzbgeek.test', 'apikey', 'guid', 'indexerId', SAB_KEY]) assert.ok(!body.includes(secret), secret)
  assert.ok(context.searches.every((url) => new URL(url).searchParams.get('cat') === '2000,5000'))
  assert.ok(!context.logs.join('\n').includes(INDEXER_KEY))
})

test('Usenet search trouble is a warning; torrent search keeps working', async () => {
  const torrent = { fileName: 'Sintel 2010 720p', fileUrl: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, fileSize: 700_000_000, nbSeeders: 9, siteUrl: 'https://yts.test' }
  const context = await world({ qbSearch: [torrent], searchXml: '<error code="100" description="Incorrect user credentials"/>' })
  const found = await context.controller.search({ query: 'Sintel', kind: 'video' })
  assert.equal(found.results.length, 1)
  assert.match(found.warnings[0], /Usenet search failed: NZBgeek refused the search/)
  const off = await world({ qbSearch: [torrent], downloader: null })
  const plain = await off.controller.search({ query: 'Sintel', kind: 'video' })
  assert.equal(plain.usenet, false)
  assert.equal(plain.results.length, 1)
  const status = await off.controller.status()
  assert.equal(status.downloaders.torrent.available, true)
  assert.equal(status.downloaders.usenet.available, false)
  assert.match(status.downloaders.usenet.problem, /SABnzbd is not configured/)
})

test('queuing an NZB writes the job record first, then uploads it to SABnzbd in the destination\'s category', async () => {
  for (const [destination, category] of [['family', 'tomifin-family'], ['private', 'tomifin-private']]) {
    const context = await world()
    const recordBeforeUpload = []
    const add = context.sab.addFile
    context.sab.addFile = async (...args) => { recordBeforeUpload.push(await readdir(join(context.stateRoot, 'tomifin'))); return add(...args) }
    const { queued } = await searchAndQueue(context, destination)
    assert.deepEqual(recordBeforeUpload, [[`${id(1)}.json`]])
    assert.deepEqual(context.sab.calls.find((call) => call[0] === 'addFile').slice(1, 3), [`tomifin-${id(1)}`, category])
    assert.equal(queued.job.downloader, 'sabnzbd')
    assert.equal(queued.job.destination, destination)
    const record = JSON.parse(await readFile(join(context.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8'))
    assert.deepEqual([record.version, record.downloader, record.category, record.remoteId], [2, 'sabnzbd', category, 'SABnzbd_nzo_1'])
    assert.match(context.fetched[0], new RegExp(`apikey=${INDEXER_KEY}`), 'the agent fetches the NZB with the key itself')
    assert.ok(!JSON.stringify(record).includes(INDEXER_KEY))
    assert.ok(!JSON.stringify(queued).includes(INDEXER_KEY))
  }
})

test('the same NZB cannot be queued twice, by result, GUID or contents', async () => {
  const context = await world({ searchXml: newznabXml([{ title: 'Sintel.2010.1080p', guid: 'g1' }, { title: 'Sintel 2010 1080p REPOST', guid: 'g9' }]) })
  const found = await context.controller.search({ query: 'Sintel', kind: 'video' })
  const [first, second] = found.results
  await context.controller.download({ resultId: first.id, destination: 'family' })
  await assert.rejects(context.controller.download({ resultId: first.id, destination: 'private' }), (error) => ['duplicate', 'result-expired'].includes(error.code))
  const again = await context.controller.search({ query: 'Sintel', kind: 'video' })
  await assert.rejects(context.controller.download({ resultId: again.results.find((result) => result.title === first.title).id, destination: 'family' }), { code: 'duplicate' })
  await assert.rejects(context.controller.download({ resultId: second.id, destination: 'family' }), { code: 'duplicate' }, 'another post of the same segments is the same download')
  assert.equal(context.sab.calls.filter((call) => call[0] === 'addFile').length, 1)
})

test('a refused upload leaves no record; a lost answer is never resubmitted blindly', async () => {
  const refused = await world()
  refused.sab.state.nextAdd = 'reject'
  await assert.rejects(searchAndQueue(refused), { code: 'sabnzbd-refused' })
  assert.deepEqual(await readdir(join(refused.stateRoot, 'tomifin')), [])

  const found = await world()
  found.sab.state.nextAdd = 'lost-but-added'
  const { queued } = await searchAndQueue(found)
  assert.equal(queued.job.downloader, 'sabnzbd', 'the job was found in SABnzbd by its name')
  assert.equal(JSON.parse(await readFile(join(found.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8')).remoteId, 'SABnzbd_nzo_1')

  const lost = await world()
  lost.sab.state.nextAdd = 'lost'
  await assert.rejects(searchAndQueue(lost), { code: 'unconfirmed' })
  const record = JSON.parse(await readFile(join(lost.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8'))
  assert.ok(record.unconfirmedSince)
  const listed = await lost.controller.list()
  assert.equal(listed.jobs[0].message, 'Waiting for SABnzbd to confirm')
  const again = await lost.controller.search({ query: 'Sintel', kind: 'video' })
  await assert.rejects(lost.controller.download({ resultId: again.results[0].id, destination: 'family' }), { code: 'duplicate' })
  assert.equal(lost.sab.calls.filter((call) => call[0] === 'addFile').length, 1, 'never uploaded twice')
})

test('SABnzbd without Tomifin\'s categories, or offline, refuses before anything is recorded', async () => {
  const context = await world({ sab: fakeSab({ categories: ['*', 'tomify-music'] }) })
  await assert.rejects(searchAndQueue(context), (error) => error.code === 'usenet-unavailable' && /tomifin-family or tomifin-private category/.test(error.message))
  assert.deepEqual(await readdir(join(context.stateRoot, 'tomifin')).catch(() => []), [])
  assert.equal(context.sab.calls.some((call) => call[0] === 'addFile'), false)
})

test('the downloads list shows SABnzbd progress, speed and time left, and pause/resume/cancel go to SABnzbd', async () => {
  const context = await world()
  await searchAndQueue(context)
  const [view] = (await context.controller.list()).jobs
  assert.deepEqual([view.downloader, view.downloaderLabel, view.type, view.status, view.progress, view.eta, view.downloadSpeed], ['sabnzbd', 'SABnzbd', 'usenet', 'downloading', 75, 125, 2048 * 1024])
  assert.equal(view.downloaded, 750 * 1024 * 1024)
  assert.ok(!JSON.stringify(view).match(/SABnzbd_nzo|tomifin-family|storage|\/tmp/), 'no SABnzbd ids, categories or paths')
  const paused = await context.controller.pause({ id: id(1) })
  assert.equal(paused.job.status, 'paused')
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'pause'), ['pause', 'SABnzbd_nzo_1'])
  await context.controller.resume({ id: id(1) })
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'resume'), ['resume', 'SABnzbd_nzo_1'])
  assert.equal(context.qb.calls.some((call) => ['pause', 'resume'].includes(call[0])), false)
  const cancelled = await context.controller.cancel({ id: id(1) })
  assert.deepEqual(cancelled, { cancelled: true, filesDeleted: true, downloaderRemoved: true })
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'deleteQueued'), ['deleteQueued', 'SABnzbd_nzo_1', true])
  assert.deepEqual((await context.controller.list()).jobs, [])
})

test('a finished Family film is published through the Family importer as a verified copy, never shown half-done', async () => {
  const context = await world({ env: { TOMIFY_TOMIFIN_USENET_PUBLISH: 'copy' } })
  await searchAndQueue(context, 'family')
  assert.deepEqual(await tree(context.family), [], 'nothing in the library while SABnzbd downloads')
  const storage = await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.BluRay.x264-GRP.mkv': film, 'Sintel.nfo': 'nfo' })
  const [view] = (await settle(context)).jobs
  assert.equal(view.status, 'completed', view.message)
  assert.equal(view.message, 'In the Family library')
  const published = join(context.family, 'Sintel (2010)', 'Sintel (2010).mkv')
  assert.equal(await readFile(published, 'utf8'), film)
  assert.notEqual((await stat(published)).ino, (await stat(join(storage, 'Sintel.2010.1080p.BluRay.x264-GRP.mkv'))).ino)
  assert.ok((await stat(join(storage, 'Sintel.2010.1080p.BluRay.x264-GRP.mkv'))).isFile(), 'SABnzbd\'s copy is kept')
  assert.equal(context.sab.calls.some((call) => call[0] === 'deleteHistory'), false)
  const removed = await context.controller.cancel({ id: id(1) })
  assert.equal(removed.filesDeleted, false)
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'deleteHistory'), ['deleteHistory', 'SABnzbd_nzo_1', false])
  assert.equal(await readFile(published, 'utf8'), film, 'removing the job never touches the library')
})

test('a finished Family season pack lands in the TV folder; cleanup happens only when turned on and verified', async () => {
  const context = await world({ env: { TOMIFY_TOMIFIN_USENET_CLEANUP: 'true' }, searchXml: newznabXml([{ title: 'MobLand.S01.1080p.WEB-DL', guid: 'm1' }]) })
  await searchAndQueue(context, 'family', 'MobLand')
  const episode = (n) => `episode-${n}-`.padEnd(4000, 'e')
  await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'MobLand.S01E01.1080p.WEB-DL.mkv': episode(1), 'MobLand.S01E02.1080p.WEB-DL.mkv': episode(2) })
  const [view] = (await settle(context)).jobs
  assert.equal(view.status, 'completed', view.message)
  assert.deepEqual(await readdir(join(context.family, 'TV', 'MobLand', 'Season 01')), ['MobLand - S01E01.mkv', 'MobLand - S01E02.mkv'])
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'deleteHistory'), ['deleteHistory', 'SABnzbd_nzo_1', true])
})

test('a finished Private download is published as its own folder of videos and subtitles', async () => {
  const context = await world()
  await searchAndQueue(context, 'private')
  await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film, 'Sintel.2010.1080p.en.srt': 'subs', 'Sample/sample.mkv': 'sample', 'release.nfo': 'nfo' })
  const [view] = (await settle(context)).jobs
  assert.equal(view.status, 'completed', view.message)
  assert.deepEqual(await tree(context.privateLibrary), ['.tomifin-publishing/', '.tomifin-publishing/.ignore', 'Sintel.2010.1080p.BluRay.x264-GRP/', 'Sintel.2010.1080p.BluRay.x264-GRP/Sintel.2010.1080p.en.srt', 'Sintel.2010.1080p.BluRay.x264-GRP/Sintel.2010.1080p.mkv'])
  assert.deepEqual(await tree(context.family), [], 'Private never reaches Family')
})

test('failed, password-protected and unsafe downloads are held for review with a reason, and nothing is published', async () => {
  const cases = [
    ['unpack failed', async (context) => context.sab.finish('SABnzbd_nzo_1', context.completed, { 'a.rar': 'rar' }, { status: 'Failed', fail: 'Unpacking failed, CRC error' }), 'unpack-failed'],
    ['password', async (context) => context.sab.finish('SABnzbd_nzo_1', context.completed, {}, { status: 'Failed', fail: 'Unpacking failed, archive requires a password' }), 'password-protected'],
    ['archives left', async (context) => context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film, 'sintel.part01.rar': 'rar' }), 'archives-remain'],
    ['symlink', async (context) => { const storage = await context.sab.finish('SABnzbd_nzo_1', context.completed, {}); await writeFile(join(context.root, 'secret.mkv'), film); await symlink(join(context.root, 'secret.mkv'), join(storage, 'Sintel.2010.1080p.mkv')) }, 'unsafe-symlink'],
    ['outside', async (context) => { await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film }); context.sab.state.history[0].storage = join(context.root, 'state') }, 'unsafe-path'],
    ['wrong folder', async (context) => { const storage = await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film }); context.sab.state.history[0].storage = dirname(storage) }, 'unsafe-path'],
  ]
  for (const destination of ['family', 'private']) {
    for (const [label, finish, code] of cases) {
      const context = await world()
      await searchAndQueue(context, destination)
      await finish(context)
      const [view] = (await settle(context)).jobs
      assert.equal(view.status, 'failed', `${destination} ${label}`)
      const library = destination === 'family' ? context.family : context.privateLibrary
      const visible = (await tree(library)).filter((entry) => !entry.startsWith('.'))
      assert.deepEqual(visible, [], `${destination} ${label}: nothing published`)
      const note = destination === 'family' ? join(library, '.review', `usenet-${id(1)}`, 'reason.json') : join(library, '.tomifin-review', id(1), 'reason.json')
      const reason = JSON.parse(await readFile(note, 'utf8'))
      assert.equal(reason.code, code, `${destination} ${label}`)
      assert.equal(reason.downloader, 'sabnzbd')
      assert.ok(!JSON.stringify(view).includes(context.root), `${destination} ${label}: no paths in the view`)
    }
  }
})

test('a download still being unpacked is not published or cancelled', async () => {
  const context = await world()
  await searchAndQueue(context)
  await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film })
  context.sab.state.history[0].status = 'Extracting'
  const [view] = (await settle(context)).jobs
  assert.deepEqual([view.status, view.message], ['downloading', 'Unpacking in SABnzbd'])
  assert.deepEqual(await tree(context.family), [])
  await assert.rejects(context.controller.cancel({ id: id(1) }), { code: 'busy' })
})

test('cancelling a failed download deletes only its own SABnzbd folder; a recovered job keeps its files', async () => {
  const context = await world()
  await searchAndQueue(context)
  await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'a.rar': 'rar' }, { status: 'Failed', fail: 'Download failed - Not on your server(s)' })
  await settle(context)
  assert.deepEqual(await context.controller.cancel({ id: id(1) }), { cancelled: true, filesDeleted: true, downloaderRemoved: true })
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'deleteHistory'), ['deleteHistory', 'SABnzbd_nzo_1', true])

  const recovered = await world()
  recovered.sab.state.queue.push({ nzo_id: 'SABnzbd_nzo_7', filename: `tomifin-${id(42)}`, cat: 'tomifin-private', status: 'Downloading', mb: '10', mbleft: '5', percentage: '50', timeleft: '0:00:10' })
  recovered.sab.state.queue.push({ nzo_id: 'SABnzbd_nzo_8', filename: 'Some.Other.Download', cat: 'tomifin-private', status: 'Downloading' })
  recovered.sab.state.queue.push({ nzo_id: 'SABnzbd_nzo_9', filename: `tomifin-${id(43)}`, cat: 'tomify-music', status: 'Downloading' })
  const { jobs } = await recovered.controller.list()
  assert.deepEqual(jobs.map((job) => [job.id, job.destination, job.keepsFilesOnCancel]), [[id(42), 'private', true]], 'only Tomifin-named jobs in Tomifin categories are adopted')
  assert.deepEqual(await recovered.controller.cancel({ id: id(42) }), { cancelled: true, filesDeleted: false, downloaderRemoved: true })
  assert.deepEqual(recovered.sab.calls.find((call) => call[0] === 'deleteQueued'), ['deleteQueued', 'SABnzbd_nzo_7', false])
})

test('a job SABnzbd forgets becomes failed after a while; an unconfirmed one is dropped', async () => {
  let clock = Date.parse('2026-10-23T10:00:00Z')
  const context = await world()
  const usenet = createTomifinUsenet({ config: context.config, tomifin: context.tomifin, stateRoot: context.stateRoot, sab: context.sab, fetchNzb: async () => ({ bytes: nzb() }), fetchImpl: async () => new Response(newznabXml([{ title: 'Sintel.2010.1080p', guid: 'g1' }])), probe: async () => ({ ok: true, duration: 5400 }), stableMs: 0, now: () => clock })
  let ids = 0
  const controller = createTomifinController({ config: context.tomifin, client: context.qb, stateRoot: context.stateRoot, usenet, randomId: () => id(++ids), now: () => clock })
  const found = await controller.search({ query: 'Sintel', kind: 'video' })
  await controller.download({ resultId: found.results[0].id, destination: 'family' })
  context.sab.state.queue = []
  assert.equal((await controller.list()).jobs[0].status, 'queued')
  clock += 16 * 60_000
  const [lost] = (await controller.list()).jobs
  assert.deepEqual([lost.status, lost.message], ['failed', 'The download is no longer in SABnzbd.'])

  const record = JSON.parse(await readFile(join(context.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8'))
  assert.equal(record.failure.code, 'downloader-lost')

  // An upload whose answer was lost, and that SABnzbd never shows, is dropped after a while.
  context.sab.state.nextAdd = 'lost'
  const other = await controller.search({ query: 'Sintel', kind: 'video' })
  await controller.cancel({ id: id(1) })
  await assert.rejects(controller.download({ resultId: other.results[0].id, destination: 'family' }), { code: 'unconfirmed' })
  assert.equal((await controller.list()).jobs.length, 1)
  clock += 16 * 60_000
  assert.deepEqual((await controller.list()).jobs, [])
})

test('an NZB link or upload becomes a normal SABnzbd job; NZBs are refused when Usenet is off', async () => {
  const fetchLink = async (url) => (url === 'https://files.test/sintel.nzb' ? { bytes: nzb('link', 'Sintel Linked') } : (() => { throw new Error('unexpected') })())
  const context = await world({ fetchLink })
  const checked = await context.controller.link({ link: 'https://files.test/sintel.nzb' })
  assert.equal(checked.detected, 'nzb')
  assert.deepEqual([checked.result.type, checked.result.linkType, checked.result.title, checked.result.source], ['usenet', 'nzb', 'Sintel Linked', 'Added link'])
  assert.ok(!JSON.stringify(checked).includes('files.test'), 'the submitted link is never sent back')
  const queued = await context.controller.download({ resultId: checked.result.id, destination: 'private' })
  assert.equal(queued.job.downloader, 'sabnzbd')
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'addFile').slice(1, 3), [`tomifin-${id(1)}`, 'tomifin-private'])
  await assert.rejects(context.controller.link({ file: { name: 'again.nzb', data: nzb('link', 'Renamed').toString('base64') } }), { code: 'duplicate' })
  assert.ok(!context.logs.join('\n').includes('files.test'))

  const off = await world({ downloader: null })
  await assert.rejects(off.controller.link({ file: { name: 'a.nzb', data: nzb().toString('base64') } }), (error) => error.code === 'usenet-unavailable' && /SABnzbd is not configured/.test(error.message))
  const magnet = await off.controller.link({ link: `magnet:?xt=urn:btih:${'d'.repeat(40)}&dn=Torrent%20Still%20Works` })
  assert.equal(magnet.detected, 'magnet')
})

test('a library outage keeps a finished download waiting with growing gaps, never failing it, and it publishes once the library is back', async () => {
  assert.deepEqual([1, 2, 3, 6, 7, 40].map(publishRetryDelay), [30_000, 60_000, 120_000, 960_000, 1_800_000, 1_800_000])
  let clock = Date.parse('2026-10-23T10:00:00Z')
  const context = await world()
  const usenet = createTomifinUsenet({ config: context.config, tomifin: context.tomifin, stateRoot: context.stateRoot, sab: context.sab, fetchNzb: async () => ({ bytes: nzb() }), fetchImpl: async () => new Response(newznabXml([{ title: 'Sintel.2010.1080p', guid: 'g1' }])), probe: async () => ({ ok: true, duration: 5400 }), stableMs: 0, now: () => clock })
  const controller = createTomifinController({ config: context.tomifin, client: context.qb, stateRoot: context.stateRoot, usenet, randomId: () => id(1), now: () => clock })
  const found = await controller.search({ query: 'Sintel', kind: 'video' })
  await controller.download({ resultId: found.results[0].id, destination: 'private' })
  await context.sab.finish('SABnzbd_nzo_1', context.completed, { 'Sintel.2010.1080p.mkv': film })
  // The Private pool drops out (here: its folder disappears) for far longer than 40 attempts' worth of retries.
  const away = `${context.privateLibrary}-offline`
  await rename(context.privateLibrary, away)
  const record = async () => JSON.parse(await readFile(join(context.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8'))
  for (let round = 0; round < 60; round += 1) {
    await controller.observe()
    clock += 31 * 60_000
  }
  const waiting = await record()
  assert.equal(waiting.import.state, 'pending')
  assert.ok(waiting.import.attempts >= 50, `retried ${waiting.import.attempts} times`)
  assert.equal(Date.parse(waiting.import.nextAttemptAt) - Date.parse(waiting.import.at), 30 * 60_000, 'retries settle at every 30 minutes')
  const [view] = (await controller.list()).jobs
  assert.equal(view.status, 'downloading')
  assert.match(view.message, /^Waiting to publish to Private/)
  await rename(away, context.privateLibrary)
  await controller.observe()
  assert.equal((await record()).import.state, 'published')
  assert.equal(await readFile(join(context.privateLibrary, 'Sintel.2010.1080p', 'Sintel.2010.1080p.mkv'), 'utf8'), film)
})

// ---------------------------------------------------------------------------------------------------------------
// NZBIndex (Recovery's anonymous provider) beside or instead of Newznab

test('NZBIndex alone is enough to search and queue through SABnzbd, keeping collection ids server-side', async () => {
  const nzbIndexJson = { data: { content: [
    collection('abc123DEF', 'Sintel.2010.1080p.BluRay.x264-GRP [01/45] - "sintel.part01.rar"'),
    collection('frag9', 'Sintel.2010.1080p.BluRay.x264-GRP [07/45]'),
    collection('broken', 'Sintel.2010.720p', 1_000_000_000, { complete: false }),
  ] } }
  const context = await world({ newznab: [], nzbIndex: { ...NZBINDEX, apiKey: NZBINDEX_KEY }, nzbIndexJson })
  assert.deepEqual(context.controller.status().downloaders.usenet.search, { available: true, providers: ['NZBIndex'], problem: null })
  const { found, result, queued } = await searchAndQueue(context, 'private')
  assert.equal(found.results.length, 1, 'fragments and incomplete collections are left out')
  assert.deepEqual([result.source, result.type, result.detailsUrl, result.grabs], ['NZBIndex', 'usenet', null, null])
  assert.equal(result.ageDays > 600, true)
  const search = new URL(context.searches[0])
  assert.deepEqual([search.pathname, search.searchParams.get('q'), search.searchParams.get('complete'), search.searchParams.get('key')], ['/api/search', 'Sintel', '1', NZBINDEX_KEY])
  assert.equal(context.fetched[0], `https://api.nzbindex.test/api/download/abc123DEF.nzb?key=${NZBINDEX_KEY}`, 'the NZB comes from the existing NZBIndex download endpoint')
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'addFile').slice(1, 3), [`tomifin-${id(1)}`, 'tomifin-private'])
  const record = await readFile(join(context.stateRoot, 'tomifin', `${id(1)}.json`), 'utf8')
  const browser = JSON.stringify([found, queued, await context.controller.list(), context.controller.status()])
  for (const secret of ['abc123DEF', NZBINDEX_KEY, 'api.nzbindex', 'nzbindex.test', 'part1of2', '<nzb', 'collection']) assert.ok(!browser.includes(secret), `browser: ${secret}`)
  for (const secret of [NZBINDEX_KEY, 'api.nzbindex', '<nzb']) assert.ok(!record.includes(secret) && !context.logs.join('\n').includes(secret), `record/logs: ${secret}`)
})

test('Newznab alone still works, and NZBIndex plus Newznab are searched together and merged', async () => {
  const newznabOnly = await world()
  assert.deepEqual(newznabOnly.controller.status().downloaders.usenet.search.providers, ['NZBgeek'])
  await searchAndQueue(newznabOnly)
  assert.match(newznabOnly.fetched[0], /api\.nzbgeek\.test\/api\?t=get&id=g1/)

  const both = await world({
    nzbIndex: NZBINDEX,
    searchXml: newznabXml([{ title: 'Sintel.2010.1080p.BluRay.x264-GRP', guid: 'g1', size: 2_000_000_000 }, { title: 'Sintel.2010.2160p.WEB-DL', guid: 'g2', size: 9_000_000_000 }]),
    nzbIndexJson: { data: { content: [collection('same1', 'sintel 2010 1080p bluray x264 grp', 2_010_000_000), collection('own1', 'Sintel.2010.720p.HDTV', 800_000_000), collection('near1', 'Sintel.2010.1080p.BluRay.x264-GRP', 2_500_000_000)] } },
  })
  const found = await both.controller.search({ query: 'Sintel', kind: 'video' })
  assert.deepEqual(new Set(both.searches.map((url) => new URL(url).host)), new Set(['api.nzbgeek.test', 'api.nzbindex.test']))
  const usenet = found.results.filter((result) => result.type === 'usenet')
  assert.deepEqual(usenet.map((result) => [result.source, result.title]).sort(), [
    ['NZBIndex', 'Sintel.2010.1080p.BluRay.x264-GRP'],
    ['NZBIndex', 'Sintel.2010.720p.HDTV'],
    ['NZBgeek', 'Sintel.2010.1080p.BluRay.x264-GRP'],
    ['NZBgeek', 'Sintel.2010.2160p.WEB-DL'],
  ], 'the same release within 1 % in size is shown once; a different size is kept')
  const fromIndex = usenet.find((result) => result.title === 'Sintel.2010.720p.HDTV')
  await both.controller.download({ resultId: fromIndex.id, destination: 'family' })
  assert.match(both.fetched.at(-1), /^https:\/\/api\.nzbindex\.test\/api\/download\/own1\.nzb$/, 'anonymous: no key parameter')
})

test('one Usenet provider failing keeps the others\' results, with a short warning', async () => {
  const nzbIndexJson = { data: { content: [collection('own1', 'Sintel.2010.720p.HDTV')] } }
  const indexDown = await world({ nzbIndex: NZBINDEX, nzbIndexJson, failing: ['nzbindex'] })
  const a = await indexDown.controller.search({ query: 'Sintel', kind: 'video' })
  assert.deepEqual(a.results.map((result) => result.source), ['NZBgeek'])
  assert.deepEqual(a.warnings, ['Usenet search: NZBIndex did not answer.'])
  const geekDown = await world({ nzbIndex: NZBINDEX, nzbIndexJson, failing: ['newznab'] })
  const b = await geekDown.controller.search({ query: 'Sintel', kind: 'video' })
  assert.deepEqual(b.results.map((result) => result.source), ['NZBIndex'])
  assert.deepEqual(b.warnings, ['Usenet search: NZBgeek did not answer.'])
  const allDown = await world({ nzbIndex: NZBINDEX, failing: ['newznab', 'nzbindex'], qbSearch: [{ fileName: 'Sintel 2010 720p', fileUrl: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, fileSize: 1, nbSeeders: 3, siteUrl: 'https://yts.test' }] })
  const c = await allDown.controller.search({ query: 'Sintel', kind: 'video' })
  assert.deepEqual(c.results.map((result) => result.type), ['torrent'])
  assert.equal(c.warnings.length, 1)
  assert.match(c.warnings[0], /^Usenet search failed: /)
  assert.ok(!JSON.stringify(c).includes('nzbindex.test') && !JSON.stringify(c).includes(INDEXER_KEY))
})

test('with SABnzbd but no search provider, added NZB links and uploads still download', async () => {
  const context = await world({ newznab: [], nzbIndex: null, qbSearch: [] })
  const status = context.controller.status().downloaders.usenet
  assert.deepEqual([status.available, status.search.available], [true, false])
  const found = await context.controller.search({ query: 'Sintel', kind: 'video' })
  assert.deepEqual([found.usenet, found.results, context.searches], [false, [], []])
  const checked = await context.controller.link({ file: { name: 'sintel.nzb', data: nzb('upload', 'Sintel Upload').toString('base64') } })
  assert.equal(checked.detected, 'nzb')
  await context.controller.download({ resultId: checked.result.id, destination: 'family' })
  assert.deepEqual(context.sab.calls.find((call) => call[0] === 'addFile').slice(1, 3), [`tomifin-${id(1)}`, 'tomifin-family'])
  assert.ok(!JSON.stringify(checked).includes('<nzb') && !context.logs.join('\n').includes('<nzb'))
})

test('without SABnzbd, Usenet stays unavailable even with NZBIndex', async () => {
  const context = await world({ downloader: null, nzbIndex: NZBINDEX })
  const status = context.controller.status().downloaders.usenet
  assert.equal(status.available, false)
  assert.equal(status.search.available, false)
  assert.match(status.problem, /SABnzbd is not configured/)
  const found = await context.controller.search({ query: 'Sintel', kind: 'video' })
  assert.equal(found.usenet, false)
  assert.deepEqual(context.searches, [])
  await assert.rejects(context.controller.link({ file: { name: 'a.nzb', data: nzb().toString('base64') } }), { code: 'usenet-unavailable' })
})

test('deduplication keeps distinct non-Latin releases of the same size, and still merges equal ones', async () => {
  const context = await world({
    nzbIndex: NZBINDEX,
    searchXml: newznabXml([{ title: '千と千尋の神隠し 2001 1080p', guid: 'j1', size: 2_000_000_000 }, { title: 'Брат 1997 1080p', guid: 'r1', size: 3_000_000_000 }]),
    nzbIndexJson: { data: { content: [collection('j2', 'もののけ姫 2001 1080p', 2_005_000_000), collection('r2', 'брат.1997.1080p', 3_010_000_000), collection('e1', '★★★', 4_000_000_000), collection('e2', '☆☆☆', 4_000_000_000)] } },
  })
  const titles = (await context.controller.search({ query: 'anime', kind: 'video' })).results.map((result) => result.title).sort()
  assert.deepEqual(titles, ['Брат 1997 1080p', 'もののけ姫 2001 1080p', '千と千尋の神隠し 2001 1080p', '★★★', '☆☆☆'].sort(), 'different Japanese titles are both kept; the Cyrillic repost is merged; names with no letters or digits never match')
})
