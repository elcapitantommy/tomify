import test from 'node:test'
import assert from 'node:assert/strict'
import { INDEXER_KEY_PLACEHOLDER, fetchIndexerTorrent, parseProwlarrResults, parseTorrentIndexers, parseTorznabResults, searchTorrentIndexers } from './torrent-indexers.mjs'
import { createQbittorrentClient, torrentCandidate, torrentConfig, torrentSearchCandidates } from './torrent.mjs'

const hash = '0123456789abcdef0123456789abcdef01234567'
const other = 'fedcba9876543210fedcba9876543210fedcba98'
const prowlarr = { type: 'prowlarr', url: 'http://127.0.0.1:9696', apiKey: 'prowlarr-key' }
const jackett = { type: 'torznab', name: 'Jackett', url: 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab', apiKey: 'jackett-key' }

test('torrent indexers are read from TOMIFY_TORRENT_INDEXERS_JSON', () => {
  assert.deepEqual(parseTorrentIndexers(''), [])
  const [first, second] = parseTorrentIndexers(JSON.stringify([prowlarr, jackett]))
  assert.deepEqual({ id: first.id, type: first.type, name: first.name, origin: first.origin, categories: first.categories }, { id: 'prowlarr-1', type: 'prowlarr', name: 'Prowlarr', origin: 'http://127.0.0.1:9696', categories: '3000' })
  assert.equal(second.type, 'torznab')
  assert.throws(() => parseTorrentIndexers('{'), /valid JSON/)
  assert.throws(() => parseTorrentIndexers('{}'), /JSON array/)
  assert.throws(() => parseTorrentIndexers(JSON.stringify([{ ...prowlarr, type: 'rss' }])), /unknown type/)
  assert.throws(() => parseTorrentIndexers(JSON.stringify([{ ...prowlarr, url: 'http://192.168.1.5:9696' }])), /HTTPS \(or loopback HTTP\)/)
  assert.throws(() => parseTorrentIndexers(JSON.stringify([{ ...prowlarr, apiKey: '' }])), /missing an id or apiKey/)
  const config = torrentConfig({ TOMIFY_QBITTORRENT_URL: 'http://127.0.0.1:8081', TOMIFY_TORRENT_INDEXERS_JSON: JSON.stringify([prowlarr]) })
  assert.equal(config.indexers[0].apiKey, 'prowlarr-key')
})

test('Torznab results keep magnets, store indexer links without the API key and read seeds and peers', () => {
  const [indexer] = parseTorrentIndexers(JSON.stringify([jackett]))
  const xml = `<rss><channel>
    <item><title>Flood (1990) FLAC</title><guid>https://1337x.to/torrent/1/flood/</guid><comments>https://1337x.to/torrent/1/flood/</comments><size>400000000</size>
      <jackettindexer id="1337x">1337x</jackettindexer>
      <torznab:attr name="seeders" value="42"/><torznab:attr name="peers" value="50"/><torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${hash}&amp;dn=Flood"/></item>
    <item><title>Flood MP3</title><link>http://127.0.0.1:9117/dl/rutracker/?jackett_apikey=jackett-key&amp;path=abc</link><enclosure url="http://127.0.0.1:9117/dl/rutracker/?jackett_apikey=jackett-key&amp;path=abc" length="90000000" type="application/x-bittorrent"/>
      <torznab:attr name="seeders" value="3"/></item>
    <item><title>No link</title></item>
  </channel></rss>`
  const [magnet, file] = parseTorznabResults(xml, indexer)
  assert.deepEqual({ fileName: magnet.fileName, fileUrl: magnet.fileUrl, fileSize: magnet.fileSize, nbSeeders: magnet.nbSeeders, nbLeechers: magnet.nbLeechers, siteName: magnet.siteName, descrLink: magnet.descrLink }, { fileName: 'Flood (1990) FLAC', fileUrl: `magnet:?xt=urn:btih:${hash}&dn=Flood`, fileSize: 400000000, nbSeeders: 42, nbLeechers: 8, siteName: '1337x', descrLink: 'https://1337x.to/torrent/1/flood/' })
  assert.equal(file.fileUrl, `http://127.0.0.1:9117/dl/rutracker/?jackett_apikey=${INDEXER_KEY_PLACEHOLDER}&path=abc`)
  assert.equal(file.fileSize, 90000000)
  assert.equal(file.siteName, 'Jackett')
  assert.equal(file.nbLeechers, -1)
  assert.equal(parseTorznabResults(xml, indexer).length, 2)
})

test('Prowlarr results drop Usenet releases and fall back to an info hash', () => {
  const [indexer] = parseTorrentIndexers(JSON.stringify([prowlarr]))
  const results = parseProwlarrResults([
    { protocol: 'torrent', title: 'Flood FLAC', indexer: 'TheRARBG', seeders: 12, leechers: 2, size: 300, infoUrl: 'https://therarbg.to/post/1', downloadUrl: 'http://127.0.0.1:9696/3/download?apikey=prowlarr-key&link=xyz' },
    { protocol: 'usenet', title: 'Flood NZB', downloadUrl: 'http://127.0.0.1:9696/4/download?apikey=prowlarr-key' },
    { protocol: 'torrent', title: 'Flood hash', infoHash: other.toUpperCase(), seeders: 1 },
  ], indexer)
  assert.equal(results.length, 2)
  assert.equal(results[0].fileUrl, `http://127.0.0.1:9696/3/download?apikey=${INDEXER_KEY_PLACEHOLDER}&link=xyz`)
  assert.equal(results[0].siteName, 'TheRARBG')
  assert.equal(results[0].descrLink, 'https://therarbg.to/post/1')
  assert.equal(results[1].fileUrl, `magnet:?xt=urn:btih:${other}&dn=Flood%20hash`)
})

test('indexer searches run together, send the API key and survive one indexer failing', async () => {
  const indexers = parseTorrentIndexers(JSON.stringify([prowlarr, jackett]))
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, headers: init.headers })
    if (url.port === '9696') return Response.json([{ protocol: 'torrent', title: 'Flood', seeders: 4, magnetUrl: `magnet:?xt=urn:btih:${hash}` }])
    return new Response('', { status: 500 })
  }
  const results = await searchTorrentIndexers(indexers, 'They Might Be Giants Flood', { fetchImpl })
  assert.deepEqual(results.map((result) => result.fileName), ['Flood'])
  const search = calls.find((call) => call.url.port === '9696')
  assert.equal(search.url.pathname, '/api/v1/search')
  assert.deepEqual({ query: search.url.searchParams.get('query'), type: search.url.searchParams.get('type'), categories: search.url.searchParams.getAll('categories') }, { query: 'They Might Be Giants Flood', type: 'search', categories: ['3000'] })
  assert.equal(search.headers['x-api-key'], 'prowlarr-key')
  const torznab = calls.find((call) => call.url.port === '9117')
  assert.equal(torznab.url.pathname, '/api/v2.0/indexers/all/results/torznab/api')
  assert.deepEqual({ t: torznab.url.searchParams.get('t'), cat: torznab.url.searchParams.get('cat'), apikey: torznab.url.searchParams.get('apikey') }, { t: 'search', cat: '3000', apikey: 'jackett-key' })
  await assert.rejects(searchTorrentIndexers(indexers, 'Flood', { fetchImpl: async () => new Response('', { status: 401 }) }), /rejected the configured API key/)
  await assert.rejects(searchTorrentIndexers(indexers.slice(1), 'Flood', { fetchImpl: async () => new Response('<error code="100" description="Invalid API Key"/>') }), /Jackett: Invalid API Key/)
})

test('indexer download links are fetched with the API key restored, following redirects to magnets or files', async () => {
  const indexers = parseTorrentIndexers(JSON.stringify([prowlarr]))
  const link = `http://127.0.0.1:9696/3/download?apikey=${INDEXER_KEY_PLACEHOLDER}&link=xyz`
  const seen = []
  const magnet = await fetchIndexerTorrent(link, indexers, async (input) => { seen.push(String(input)); return new Response(null, { status: 301, headers: { location: `magnet:?xt=urn:btih:${hash}` } }) })
  assert.deepEqual(magnet, { magnet: `magnet:?xt=urn:btih:${hash}` })
  assert.equal(new URL(seen[0]).searchParams.get('apikey'), 'prowlarr-key')
  const file = await fetchIndexerTorrent(link, indexers, async (input) => String(input).includes('9696') ? new Response(null, { status: 302, headers: { location: 'https://tracker.example/t/1.torrent' } }) : new Response('d8:announce0:e'))
  assert.equal(new TextDecoder().decode(file.torrent), 'd8:announce0:e')
  await assert.rejects(fetchIndexerTorrent(link, indexers, async () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } })), /unsafe link/)
  await assert.rejects(fetchIndexerTorrent(link, indexers, async () => new Response('<html>removed</html>')), /did not return a torrent file/)
  await assert.rejects(fetchIndexerTorrent(link, indexers, async () => new Response('', { status: 404 })), /may have been removed/)
  await assert.rejects(fetchIndexerTorrent('https://elsewhere.example/a.torrent', indexers), /not from a configured indexer/)
})

test('indexer links on loopback become candidates only for a configured indexer', () => {
  const indexers = parseTorrentIndexers(JSON.stringify([prowlarr]))
  const link = `http://127.0.0.1:9696/3/download?apikey=${INDEXER_KEY_PLACEHOLDER}&link=xyz`
  const results = [{ fileName: 'Flood', fileUrl: link, nbSeeders: 5, siteName: 'TheRARBG', indexerId: 'prowlarr-1' }]
  assert.deepEqual(torrentSearchCandidates(results, { artist: 'TMBG', album: 'Flood' }, ['artist', 'album'], { indexers: [] }), [])
  const [candidate] = torrentSearchCandidates(results, { artist: 'TMBG', album: 'Flood' }, ['artist', 'album'], { indexers })
  assert.deepEqual({ channel: candidate.channel, providerId: candidate.provenance.providerId, searchSource: candidate.provenance.searchSource, link: candidate.provenance.link, url: candidate.url }, { channel: 'TheRARBG', providerId: 'qbittorrent-search', searchSource: 'prowlarr-1', link, url: 'http://127.0.0.1:9696/3/download' })
  assert.equal(torrentCandidate(link, {}, { indexers }).provenance.resultId, candidate.provenance.resultId)
})

test('the same torrent from a plugin and an indexer appears once, with the higher seed count', () => {
  const results = [
    { fileName: 'Flood (plugin)', fileUrl: `magnet:?xt=urn:btih:${hash}`, nbSeeders: 90, siteUrl: 'https://thepiratebay.org' },
    { fileName: 'Flood (indexer)', fileUrl: `magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Ftracker.test`, nbSeeders: 120, siteName: '1337x', indexerId: 'prowlarr-1' },
  ]
  const candidates = torrentSearchCandidates(results, { artist: 'TMBG', album: 'Flood' }, ['artist', 'album'])
  assert.deepEqual(candidates.map((candidate) => [candidate.title, candidate.provenance.seeds]), [['Flood (indexer)', 120]])
})

function fakeQbittorrent({ plugins = [], pluginResults = [], indexerResponse = () => Response.json([]) } = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.port === '9696') return indexerResponse(url)
    if (url.pathname === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc123; path=/' } })
    if (url.pathname === '/api/v2/transfer/info') return Response.json({ connection_status: 'connected' })
    if (url.pathname === '/api/v2/search/plugins') return Response.json(plugins)
    if (url.pathname === '/api/v2/search/start') return Response.json({ id: 7 })
    if (url.pathname === '/api/v2/search/status') return Response.json([{ id: 7, status: 'Stopped' }])
    if (url.pathname === '/api/v2/search/results') return Response.json({ results: pluginResults })
    if (url.pathname === '/api/v2/torrents/add') return new Response('Ok.')
    return new Response('', { status: url.pathname === '/api/v2/torrents/createCategory' ? 409 : 200 })
  }
  return { calls, fetchImpl }
}

test('qBittorrent search combines plugins with indexers, and searches indexers alone when no plugin is enabled', async () => {
  const indexers = parseTorrentIndexers(JSON.stringify([prowlarr]))
  const config = { url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify', indexers }
  const indexerResponse = () => Response.json([{ protocol: 'torrent', title: 'Flood (indexer)', seeders: 7, magnetUrl: `magnet:?xt=urn:btih:${other}` }])
  const both = fakeQbittorrent({ plugins: [{ name: 'piratebay', enabled: true }], pluginResults: [{ fileName: 'Flood (plugin)', fileUrl: `magnet:?xt=urn:btih:${hash}`, nbSeeders: 3 }], indexerResponse })
  const found = await createQbittorrentClient(config, both.fetchImpl).search('Flood', { sleep: async () => {} })
  assert.deepEqual(found.map((result) => result.fileName).sort(), ['Flood (indexer)', 'Flood (plugin)'])
  const indexerOnly = fakeQbittorrent({ indexerResponse })
  assert.deepEqual((await createQbittorrentClient(config, indexerOnly.fetchImpl).search('Flood')).map((result) => result.fileName), ['Flood (indexer)'])
  assert.equal(indexerOnly.calls.some((call) => call.url.pathname === '/api/v2/search/start'), false)
  const brokenIndexer = fakeQbittorrent({ plugins: [{ name: 'piratebay', enabled: true }], pluginResults: [{ fileName: 'Flood (plugin)', fileUrl: `magnet:?xt=urn:btih:${hash}`, nbSeeders: 3 }], indexerResponse: () => new Response('', { status: 503 }) })
  assert.deepEqual((await createQbittorrentClient(config, brokenIndexer.fetchImpl).search('Flood', { sleep: async () => {} })).map((result) => result.fileName), ['Flood (plugin)'])
})

test('an indexer .torrent download is fetched by the agent and uploaded to qBittorrent', async () => {
  const indexers = parseTorrentIndexers(JSON.stringify([prowlarr]))
  const config = { url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify', indexers }
  const qbt = fakeQbittorrent({ indexerResponse: () => new Response('d4:infod4:name5:Floodee') })
  await createQbittorrentClient(config, qbt.fetchImpl).add(`http://127.0.0.1:9696/3/download?apikey=${INDEXER_KEY_PLACEHOLDER}`, { tag: 'tomify-job-1', savePath: '/srv/torrents' })
  const add = qbt.calls.find((call) => call.url.pathname === '/api/v2/torrents/add')
  assert.ok(add.init.body instanceof FormData)
  assert.equal(add.init.body.get('tags'), 'tomify-job-1')
  assert.equal(add.init.body.get('category'), 'tomify')
  assert.equal(add.init.body.get('urls'), null)
  assert.equal(await add.init.body.get('torrents').text(), 'd4:infod4:name5:Floodee')
  const magnet = fakeQbittorrent({ indexerResponse: () => new Response(null, { status: 301, headers: { location: `magnet:?xt=urn:btih:${hash}` } }) })
  await createQbittorrentClient(config, magnet.fetchImpl).add(`http://127.0.0.1:9696/3/download?apikey=${INDEXER_KEY_PLACEHOLDER}`, { tag: 'tomify-job-2', savePath: '/srv/torrents' })
  const magnetAdd = magnet.calls.find((call) => call.url.pathname === '/api/v2/torrents/add')
  assert.equal(new URLSearchParams(String(magnetAdd.init.body)).get('urls'), `magnet:?xt=urn:btih:${hash}`)
})
