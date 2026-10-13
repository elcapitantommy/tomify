import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloaderConfig, findCompletedAudio, parseIndexerConfig, parseNewznabResults, selectCompletedAudio, submitDownloader, usenetSearchQuery, validateCompletedPath } from './usenet.mjs'

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
