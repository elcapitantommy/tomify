import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TRACKER_LISTS, MAX_NEW_TRACKERS, createPublicTrackerLists, magnetTrackers, newTrackers, parseTrackerList, torrentPrivacy, trackerListsConfig, trackerUrl } from './tomifin-trackers.mjs'
import { createQbittorrentClient } from './torrent.mjs'

const hash = '0123456789abcdef0123456789abcdef01234567'

test('only public udp, http(s) and websocket trackers without credentials are accepted', () => {
  for (const good of ['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.example.org/announce', 'wss://tracker.webtorrent.dev', 'udp://93.184.216.34:6969']) assert.ok(trackerUrl(good), good)
  for (const bad of ['', 'ftp://t.example.org', 'http://user:pw@t.example.org/a', 'udp://127.0.0.1:80', 'udp://192.168.1.2:80', 'http://[::1]/a', 'udp://localhost:1', 'udp://box.local:1', 'udp://intranet:1', 'javascript:alert(1)', 'udp://a.example.org/x y', `udp://a.example.org/${'x'.repeat(400)}`]) assert.equal(trackerUrl(bad), null, bad)
})

test('tracker lists are parsed one URL per line, deduplicated and capped', () => {
  assert.deepEqual(parseTrackerList('udp://a.example.org:1/announce\n\nUDP://A.example.org:1/announce/\n# comment\nnot a url\r\nhttps://b.example.org/announce\n'), ['udp://a.example.org:1/announce', 'https://b.example.org/announce'])
  assert.equal(parseTrackerList(Array.from({ length: 100 }, (_, i) => `udp://t${i}.example.org:1`).join('\n')).length, 40)
})

test('only a magnet for exactly this info hash gives trackers', () => {
  const magnet = `magnet:?xt=urn:btih:${hash.toUpperCase()}&tr=udp%3A%2F%2Fa.example.org%3A1&tr=udp%3A%2F%2F10.0.0.1%3A1`
  assert.deepEqual(magnetTrackers(magnet, hash), ['udp://a.example.org:1'])
  assert.deepEqual(magnetTrackers(magnet, 'f'.repeat(40)), [])
  assert.deepEqual(magnetTrackers('https://example.org/a.torrent', hash), [])
})

test('a torrent is private by any of qBittorrent\'s signs, and unknown while its details are missing', () => {
  assert.equal(torrentPrivacy({ torrent: { private: true } }), true)
  assert.equal(torrentPrivacy({ properties: { is_private: true } }), true)
  assert.equal(torrentPrivacy({ trackers: [{ url: '** [LSD] **', msg: 'This torrent is private' }] }), true)
  assert.equal(torrentPrivacy({ torrent: { state: 'metaDL' } }), null)
  assert.equal(torrentPrivacy({ torrent: { state: 'stalledDL', private: false }, properties: { is_private: false }, trackers: [{ url: '** [DHT] **', msg: '' }] }), false)
})

test('new trackers skip ones the torrent has, put search finds first and stop at the limit', () => {
  const picked = newTrackers({ existing: [{ url: 'udp://a.example.org:1/' }], fromSearch: ['udp://a.example.org:1', 'udp://b.example.org:1'], fromLists: ['udp://b.example.org:1', 'udp://c.example.org:1'] })
  assert.deepEqual(picked, { search: ['udp://b.example.org:1'], lists: ['udp://c.example.org:1'] })
  const many = Array.from({ length: 100 }, (_, i) => `udp://t${i}.example.org:1`)
  const capped = newTrackers({ fromSearch: many.slice(0, 50), fromLists: many.slice(50) })
  assert.equal(capped.search.length + capped.lists.length, MAX_NEW_TRACKERS)
})

test('the public lists are configurable, cached for six hours, and a failure falls back to the cached copy', async () => {
  assert.deepEqual(trackerListsConfig({}), [...DEFAULT_TRACKER_LISTS])
  assert.deepEqual(trackerListsConfig({ TOMIFY_TOMIFIN_TRACKER_LISTS: 'off' }), [])
  assert.deepEqual(trackerListsConfig({ TOMIFY_TOMIFIN_TRACKER_LISTS: 'https://a.example.org/list.txt, http://b.example.org/x, nonsense' }), ['https://a.example.org/list.txt'])
  let clock = 0
  let fail = false
  const fetched = []
  const publicTrackers = createPublicTrackerLists({ lists: ['https://a.example.org/list.txt'], now: () => clock, fetchLink: async (url, { maxBytes }) => { fetched.push([url, maxBytes]); if (fail) throw new Error('down'); return { bytes: Buffer.from('udp://a.example.org:1\n') } } })
  assert.deepEqual(await publicTrackers(), { trackers: ['udp://a.example.org:1'], failed: 0, lists: 1 })
  await publicTrackers()
  assert.equal(fetched.length, 1)
  clock += 7 * 60 * 60_000
  fail = true
  assert.deepEqual(await publicTrackers(), { trackers: ['udp://a.example.org:1'], failed: 1, lists: 1 })
  assert.equal(fetched.length, 2)
})

test('the qBittorrent client adds trackers in one call and asks for a reannounce', async () => {
  const requests = []
  const fetchImpl = async (url, init = {}) => { requests.push([String(url), init.method || 'GET', init.body ? String(init.body) : null]); return new Response(String(url).includes('trackers?') ? '[]' : String(url).includes('properties') ? '{"is_private":false}' : '', { status: 200 }) }
  const client = createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: '', password: '' }, fetchImpl)
  assert.deepEqual(await client.trackers(hash), [])
  assert.deepEqual(await client.properties(hash), { is_private: false })
  await client.addTrackers(hash, ['udp://a.example.org:1', 'udp://b.example.org:1'])
  assert.deepEqual(requests.slice(2).map(([url, method, body]) => [url, method, body]), [
    ['http://127.0.0.1:8081/api/v2/torrents/addTrackers', 'POST', new URLSearchParams({ hash, urls: 'udp://a.example.org:1\nudp://b.example.org:1' }).toString()],
    ['http://127.0.0.1:8081/api/v2/torrents/reannounce', 'POST', new URLSearchParams({ hashes: hash }).toString()],
  ])
})
