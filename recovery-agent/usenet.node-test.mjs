import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloaderConfig, findCompletedAudio, nzbIndexConfig, nzbIndexDownloadUrl, nzbIndexSearchUrl, parseIndexerConfig, parseNewznabResults, parseNzbIndexResults, searchNzbIndex, searchUsenetProviders, selectCompletedAudio, submitDownloader, usenetCapability, usenetSearchQuery, validateCompletedPath } from './usenet.mjs'

test('builds independent artist, track, and release queries', () => {
  const track = { artist: 'Massive Attack', title: 'Teardrop', album: 'Mezzanine' }
  assert.equal(usenetSearchQuery(track, 'artist'), 'Massive Attack')
  assert.equal(usenetSearchQuery(track, 'track'), 'Teardrop')
  assert.equal(usenetSearchQuery(track, 'release'), 'Mezzanine')
  assert.throws(() => usenetSearchQuery({ artist: 'A' }, 'release'), /release\/album/)
})

test('parses provider-neutral Newznab results without exposing credentials', () => {
  const [result] = parseNewznabResults('<rss><channel><item><title>Artist - Album FLAC</title><guid>https://indexer.test/api?t=get&amp;id=abc&amp;apikey=secret</guid><comments>https://indexer.test/details/abc?apikey=secret</comments><newznab:attr name="size" value="1234"/></item></channel></rss>', { id: 'one', name: 'Indexer', url: 'https://indexer.test' }, 'release')
  assert.equal(result.channel, 'Indexer')
  assert.equal(result.provenance.guid, 'abc')
  assert.equal(result.provenance.searchMode, 'release')
  assert.doesNotMatch(JSON.stringify(result), /secret|apikey/i)
})

test('requires secure indexers except loopback development endpoints', () => {
  assert.throws(() => parseIndexerConfig(JSON.stringify([{ url: 'http://indexer.test', apiKey: 'secret' }])), /HTTPS/)
  assert.equal(parseIndexerConfig(JSON.stringify([{ id: 'local', url: 'http://127.0.0.1:9117', apiKey: 'secret' }]))[0].id, 'local')
})

test('parses and normalizes NZBIndex collections without exposing its API key', () => {
  const config = nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: 'server-secret' })
  const posted = 1_720_733_190
  const [result] = parseNzbIndexResults({ data: { content: [{ id: '759d4736-eac6-3320-83dd-44cd3979f652', name: 'Artist - Album FLAC', poster: 'poster@example.test', posted, size: 123456, fileCount: 8, complete: true, groups: ['alt.binaries.sounds.lossless'] }] }, error: false }, config, 'release', (posted + 172800) * 1000)
  assert.equal(result.channel, 'NZBIndex')
  assert.equal(result.url, 'https://www.nzbindex.com/collection/759d4736-eac6-3320-83dd-44cd3979f652')
  assert.equal(result.provenance.providerType, 'nzbindex')
  assert.equal(result.provenance.collectionId, '759d4736-eac6-3320-83dd-44cd3979f652')
  assert.equal(result.provenance.postedAt, '2024-07-11T21:26:30.000Z')
  assert.equal(result.provenance.ageDays, 2)
  assert.equal(result.provenance.searchMode, 'release')
  assert.equal(result.provenance.size, 123456)
  assert.doesNotMatch(JSON.stringify(result), /server-secret|\bkey\b/i)
})

test('configures NZBIndex for anonymous use when its optional API key is unset', () => {
  const absent = nzbIndexConfig({})
  const blank = nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: '   ' })
  assert.equal(absent.apiKey, '')
  assert.equal(blank.apiKey, '')
  assert.equal(absent.apiUrl, 'https://api.nzbindex.com')
})

test('constructs anonymous NZBIndex search requests without an empty key parameter', async () => {
  const config = nzbIndexConfig({})
  const track = { artist: 'Massive Attack', title: 'Teardrop', album: 'Mezzanine' }
  const url = nzbIndexSearchUrl(config, track, 'track')
  assert.equal(url.origin + url.pathname, 'https://api.nzbindex.com/api/search')
  assert.equal(url.searchParams.get('q'), 'Teardrop')
  assert.equal(url.searchParams.has('key'), false)
  const calls = []
  await searchNzbIndex(config, track, 'track', async (requestUrl, init) => {
    calls.push({ url: String(requestUrl), init })
    return { ok: true, json: async () => ({ data: { content: [] }, error: false }) }
  })
  assert.equal(new URL(calls[0].url).searchParams.has('key'), false)
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

test('constructs NZBIndex query modes and optional authenticated server-side requests', async () => {
  const config = nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: 'server-secret' })
  const track = { artist: 'Massive Attack', title: 'Teardrop', album: 'Mezzanine' }
  for (const [mode, query] of [['artist', 'Massive Attack'], ['track', 'Teardrop'], ['release', 'Mezzanine']]) {
    const url = nzbIndexSearchUrl(config, track, mode)
    assert.equal(url.origin + url.pathname, 'https://api.nzbindex.com/api/search')
    assert.equal(url.searchParams.get('q'), query)
    assert.equal(url.searchParams.get('max'), '40')
    assert.equal(url.searchParams.get('sort'), 'agedesc')
    assert.equal(url.searchParams.get('key'), 'server-secret')
  }
  const calls = []
  await searchNzbIndex(config, track, 'track', async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, json: async () => ({ data: { content: [] }, error: false }) }
  })
  assert.match(calls[0].url, /^https:\/\/api\.nzbindex\.com\/api\/search\?/)
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

test('returns NZBIndex and Newznab results together when both are configured', async () => {
  const nzbIndex = nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: 'server-secret' })
  const newznab = [{ id: 'newznab-one', name: 'Newznab One', url: 'https://newznab.test', apiKey: 'newznab-secret', categories: '3000' }]
  const fetchImpl = async (url) => String(url).startsWith('https://api.nzbindex.com')
    ? { ok: true, json: async () => ({ data: { content: [{ id: 'nzbindex-id', name: 'NZBIndex result' }] }, error: false }) }
    : { ok: true, text: async () => '<rss><channel><item><title>Newznab result</title><guid>newznab-id</guid></item></channel></rss>' }
  const results = await searchUsenetProviders(newznab, nzbIndex, { title: 'Track' }, 'track', fetchImpl)
  assert.deepEqual(results.map((result) => result.provenance.providerType), ['newznab', 'nzbindex'])
})

test('constructs NZBIndex NZB downloads with credentials only in the server request URL', () => {
  const config = nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: 'server-secret' })
  const url = new URL(nzbIndexDownloadUrl(config, '759d4736-eac6-3320-83dd-44cd3979f652'))
  assert.equal(url.origin + url.pathname, 'https://api.nzbindex.com/api/download/759d4736-eac6-3320-83dd-44cd3979f652.nzb')
  assert.equal(url.searchParams.get('key'), 'server-secret')
  assert.throws(() => nzbIndexDownloadUrl(config, '../escape'), /Invalid NZBIndex collection id/)
})

test('constructs anonymous NZBIndex NZB downloads without an empty key parameter', () => {
  const config = nzbIndexConfig({})
  const url = new URL(nzbIndexDownloadUrl(config, '759d4736-eac6-3320-83dd-44cd3979f652'))
  assert.equal(url.origin + url.pathname, 'https://api.nzbindex.com/api/download/759d4736-eac6-3320-83dd-44cd3979f652.nzb')
  assert.equal(url.searchParams.has('key'), false)
})

test('enables Usenet with either indexer type plus a downloader and download directory', () => {
  const downloader = { type: 'sabnzbd' }
  const anonymousNzbIndex = nzbIndexConfig({})
  assert.equal(usenetCapability({ newznabIndexers: [{}], downloader, downloadRoot: '/downloads' }).available, true)
  assert.deepEqual(usenetCapability({ nzbIndex: anonymousNzbIndex, downloader, downloadRoot: '/downloads' }), { available: true, providerCount: 1 })
  assert.deepEqual(usenetCapability({ nzbIndex: nzbIndexConfig({ TOMIFY_NZBINDEX_API_KEY: 'optional-key' }), downloader, downloadRoot: '/downloads' }), { available: true, providerCount: 1 })
  assert.deepEqual(usenetCapability({ newznabIndexers: [{}], nzbIndex: {}, downloader, downloadRoot: '/downloads' }), { available: true, providerCount: 2 })
  assert.equal(usenetCapability({ nzbIndex: {}, downloadRoot: '/downloads' }).available, false)
  assert.equal(usenetCapability({ nzbIndex: {}, downloader }).available, false)
})

test('keeps downloader credentials in server-side requests and uses the NZBGet append contract', async () => {
  assert.throws(() => downloaderConfig({ TOMIFY_SABNZBD_URL: 'http://sab.example', TOMIFY_SABNZBD_API_KEY: 'secret' }), /HTTPS/)
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, json: async () => ({ result: 42 }) } }
  const config = downloaderConfig({ TOMIFY_NZBGET_URL: 'http://127.0.0.1:6789', TOMIFY_NZBGET_USERNAME: 'tom', TOMIFY_NZBGET_PASSWORD: 'secret', TOMIFY_USENET_CATEGORY: 'music' })
  const result = await submitDownloader(config, 'https://indexer.test/api?t=get&id=abc&apikey=hidden', 'Tomify test', fetchImpl)
  assert.deepEqual(result, { downloader: 'nzbget', remoteId: '42' })
  const request = JSON.parse(calls[0].init.body)
  assert.equal(request.method, 'append')
  assert.equal(request.params[0], 'Tomify test.nzb')
  assert.equal(request.params[1], 'https://indexer.test/api?t=get&id=abc&apikey=hidden')
  assert.match(calls[0].init.headers.authorization, /^Basic /)
})

test('validates completion paths and rejects symlinks during bounded traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-usenet-test-'))
  const job = join(root, 'job'); await mkdir(job); await writeFile(join(job, '01 - Track.flac'), 'audio')
  assert.equal(await validateCompletedPath(job, root), job)
  assert.equal((await findCompletedAudio(job)).files.length, 1)
  await symlink(join(job, '01 - Track.flac'), join(job, 'linked.flac'))
  await assert.rejects(findCompletedAudio(job), /Symlinks/)
  await assert.rejects(validateCompletedPath(tmpdir(), root), /outside/)
})

test('selects the completed audio whose filename best matches the wanted title', () => {
  const chosen = selectCompletedAudio([{ name: '01 Intro.flac', path: '/x/1', size: 1 }, { name: '02 Teardrop.flac', path: '/x/2', size: 1 }], { title: 'Teardrop' })
  assert.equal(chosen.path, '/x/2')
})
