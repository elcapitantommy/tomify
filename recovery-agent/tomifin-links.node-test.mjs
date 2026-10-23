import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { LinkError, MAX_TORRENT_FILE_BYTES, createLinkFetcher, decodeBencode, detectPayload, inspectSubmission, parseMagnet, parseNzb, parseTorrentFile, unsafeAddress } from './tomifin-links.mjs'

// A small bencode writer, so the tests build real .torrent files.
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return bencode(Buffer.from(value))
  if (Number.isInteger(value)) return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const keys = Object.keys(value).sort()
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((key) => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}
const v1Info = { length: 1_000_000, name: 'Sintel.2010.1080p.mkv', 'piece length': 262144, pieces: Buffer.alloc(80, 1) }
const torrentBytes = (info = v1Info, extra = {}) => bencode({ announce: 'https://tracker.test/announce?passkey=SECRETPASSKEY', info, ...extra })
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

const nzbXml = ({ head = '<head><meta type="name">Sintel 2010 1080p</meta></head>', segments = ['<segment bytes="500000" number="1">part1of2.abc@news.test</segment>', '<segment bytes="400000" number="2">part2of2.abc@news.test</segment>'], prolog = '<?xml version="1.0" encoding="utf-8"?>' } = {}) => `${prolog}
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  ${head}
  <file poster="poster@example.test" date="1700000000" subject="Sintel [1/2] - &quot;sintel.part01.rar&quot; yEnc (1/2)">
    <groups><group>alt.binaries.test</group></groups>
    <segments>${segments.join('')}</segments>
  </file>
</nzb>`

const code = (expected) => (error) => error instanceof LinkError && error.code === expected

test('magnet links: v1 hex, v1 base32, v2 and hybrid', () => {
  const hex = 'c9e15763f722f23e98a29decdfae341b98d53056'
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=Sintel&tr=https%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSECRET`)
  assert.equal(parsed.v1, hex)
  assert.equal(parsed.id, hex)
  assert.equal(parsed.name, 'Sintel')
  const base32 = parseMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW')
  assert.equal(base32.v1, hex)
  const v2 = 'a'.repeat(64)
  const only2 = parseMagnet(`magnet:?xt=urn:btmh:1220${v2}`)
  assert.equal(only2.v1, null)
  assert.equal(only2.v2, v2)
  assert.equal(only2.id, v2.slice(0, 40))
  const hybrid = parseMagnet(`magnet:?xt=urn:btih:${hex}&xt=urn:btmh:1220${v2}`)
  assert.deepEqual([hybrid.v1, hybrid.v2], [hex, v2])
})

test('magnet links that are malformed or name several torrents are refused', () => {
  for (const bad of [
    'magnet:?dn=no-hash',
    'magnet:?xt=urn:btih:1234',
    'magnet:?xt=urn:btih:zzzz5763f722f23e98a29decdfae341b98d53056',
    'magnet:?xt=urn:btmh:1220abcd',
    'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98',
    'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=a b',
    `magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=${'a'.repeat(9000)}`,
    'https://example.test/x',
  ]) assert.throws(() => parseMagnet(bad), code('invalid-link'), bad)
})

test('.torrent files: info hash from the info dictionary, no trackers or passkeys kept', () => {
  const bytes = torrentBytes()
  const parsed = parseTorrentFile(bytes)
  assert.equal(parsed.v1, sha1(bencode(v1Info)))
  assert.equal(parsed.v2, null)
  assert.equal(parsed.name, 'Sintel.2010.1080p.mkv')
  assert.equal(parsed.size, 1_000_000)
  assert.equal(parsed.files, 1)
  assert.doesNotMatch(JSON.stringify(parsed), /SECRETPASSKEY|tracker\.test/)

  const multi = parseTorrentFile(torrentBytes({ name: 'Show', 'piece length': 16384, pieces: Buffer.alloc(20), files: [{ length: 10, path: ['a.mkv'] }, { length: 20, path: ['Subs', 'a.srt'] }] }))
  assert.deepEqual([multi.size, multi.files], [30, 2])

  const v2Info = { name: 'Sintel', 'piece length': 16384, 'meta version': 2, 'file tree': { 'Sintel.mkv': { '': { length: 5000, 'pieces root': Buffer.alloc(32) } } } }
  const v2 = parseTorrentFile(torrentBytes(v2Info, { 'piece layers': {} }))
  assert.equal(v2.v1, null)
  assert.equal(v2.v2, createHash('sha256').update(bencode(v2Info)).digest('hex'))
  assert.equal(v2.size, 5000)
})

test('malformed, unsafe and oversized .torrent files are refused', () => {
  assert.throws(() => parseTorrentFile(Buffer.from('d4:infoi1ee')), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(Buffer.from('d4:info')), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(Buffer.concat([torrentBytes(), Buffer.from('trailing')])), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(torrentBytes({ ...v1Info, pieces: Buffer.alloc(19) })), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(torrentBytes({ ...v1Info, name: '../evil' })), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(torrentBytes({ name: 'x', 'piece length': 1, pieces: Buffer.alloc(20), files: [{ length: 1, path: ['..', 'x'] }] })), code('invalid-torrent'))
  assert.throws(() => parseTorrentFile(Buffer.alloc(MAX_TORRENT_FILE_BYTES + 1, 0x64)), code('too-large'))
  assert.throws(() => decodeBencode(Buffer.from(`${'l'.repeat(100)}${'e'.repeat(100)}`)), code('invalid-torrent'))
  assert.throws(() => decodeBencode(Buffer.from('i01e')), code('invalid-torrent'))
  assert.throws(() => decodeBencode(Buffer.from('d1:ai1e1:ai2ee')), code('invalid-torrent'), 'duplicate keys')
})

test('NZB files: name, size, segments and a stable identity from the message ids', () => {
  const parsed = parseNzb(Buffer.from(nzbXml()))
  assert.equal(parsed.kind, 'nzb')
  assert.equal(parsed.name, 'Sintel 2010 1080p')
  assert.equal(parsed.size, 900_000)
  assert.equal(parsed.segments, 2)
  assert.equal(parsed.files, 1)
  const reordered = parseNzb(Buffer.from(nzbXml({ head: '', segments: ['<segment bytes="400000" number="2">part2of2.abc@news.test</segment>', '<segment bytes="500000" number="1">part1of2.abc@news.test</segment>'] })))
  assert.equal(reordered.identity, parsed.identity, 'the same segments are the same download whatever their name or order')
  assert.equal(reordered.name, 'sintel', 'falls back to the subject when there is no name')
  assert.notEqual(reordered.sha256, parsed.sha256)
})

test('NZB files with entities, a DOCTYPE, passwords, compression or bad structure are refused', () => {
  const cases = [
    ['<?xml version="1.0"?><!DOCTYPE nzb [<!ENTITY x "y">]><nzb/>', 'invalid-nzb'],
    [nzbXml({ prolog: '<?xml version="1.0"?><!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">' }), 'invalid-nzb'],
    [nzbXml({ head: '<head><meta type="name">&xxe;</meta></head>' }), 'invalid-nzb'],
    [nzbXml({ head: '<head><meta type="name">a & b</meta></head>' }), 'invalid-nzb'],
    [nzbXml({ head: '<head><meta type="password">hunter2</meta></head>' }), 'password-protected'],
    [nzbXml({ prolog: '<?xml version="1.0" encoding="utf-16"?>' }), 'invalid-nzb'],
    [nzbXml({ segments: ['<segment bytes="-1" number="1">a@b</segment>'] }), 'invalid-nzb'],
    [nzbXml({ segments: ['<segment bytes="10" number="1"></segment>'] }), 'invalid-nzb'],
    [nzbXml({ segments: ['<segment bytes="10" number="1"><![CDATA[a@b]]></segment>'] }), 'invalid-nzb'],
    ['<nzb><file subject="x"><groups><group>a</group></groups><segments><segment bytes="1">a@b</segment></segments></file>', 'invalid-nzb'],
    ['<rss><channel/></rss>', 'invalid-nzb'],
    ['<nzb></nzb>', 'invalid-nzb'],
  ]
  for (const [xml, expected] of cases) assert.throws(() => parseNzb(Buffer.from(xml)), code(expected), xml.slice(0, 80))
  assert.throws(() => parseNzb(gzipSync(nzbXml())), code('invalid-nzb'))
  assert.throws(() => parseNzb(Buffer.from(nzbXml()), { maxBytes: 100 }), code('too-large'))
  assert.throws(() => parseNzb(Buffer.from([0xff, 0xfe, 0x3c, 0x00])), code('invalid-nzb'))
})

test('content decides the type, not the name', () => {
  assert.equal(detectPayload(torrentBytes()), 'torrent')
  assert.equal(detectPayload(Buffer.from(nzbXml())), 'nzb')
  assert.equal(detectPayload(Buffer.from('<!doctype html><html><body>Log in</body></html>')), 'html')
  assert.equal(detectPayload(Buffer.from('PK\u0003\u0004')), null)
})

test('unsafe addresses: loopback, private, link-local, CGNAT and wrapped IPv4', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-ip']) assert.equal(unsafeAddress(address), true, address)
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(unsafeAddress(address), false, address)
})

// A fake network: hosts resolve from a table, and each URL answers from a table. Records every connection.
function fakeNetwork(routes, hosts = { 'files.test': ['93.184.216.34'], 'indexer.lan': ['192.168.1.20'], 'evil.test': ['127.0.0.1'], 'mixed.test': ['93.184.216.35', '10.0.0.5'] }) {
  const connections = []
  const resolveHost = async (host) => {
    if (!hosts[host]) throw new Error('ENOTFOUND')
    return hosts[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  const transport = async (url, { address, maxBytes }) => {
    connections.push({ url: url.toString(), address })
    const route = routes[url.toString()]
    if (!route) return { status: 404, headers: {}, body: Buffer.alloc(0) }
    const answer = typeof route === 'function' ? route() : route
    if (answer.body && answer.body.length > maxBytes) throw new LinkError('too-large', 'The linked file is too large.')
    return { status: 200, headers: {}, body: Buffer.alloc(0), ...answer }
  }
  return { connections, fetchLink: createLinkFetcher({ trustedHosts: ['indexer.lan:5076'], resolveHost, transport }) }
}

test('fetches a direct .torrent and .nzb link, deciding the type from the content', async () => {
  const { fetchLink, connections } = fakeNetwork({
    'https://files.test/sintel.nzb': { body: torrentBytes() },
    'https://files.test/download?id=5': { headers: { 'content-type': 'text/html' }, body: Buffer.from(nzbXml()) },
  })
  const torrent = await inspectSubmission({ link: 'https://files.test/sintel.nzb' }, { fetchLink })
  assert.equal(torrent.kind, 'torrent', 'a misleading .nzb extension does not change what the file is')
  assert.equal(torrent.v1, sha1(bencode(v1Info)))
  const nzb = await inspectSubmission({ link: 'https://files.test/download?id=5' }, { fetchLink })
  assert.equal(nzb.kind, 'nzb', 'a misleading content type does not change what the file is')
  assert.deepEqual(connections.map((entry) => entry.address), ['93.184.216.34', '93.184.216.34'])
})

test('refuses private, loopback and mixed hosts unless the host is a configured indexer', async () => {
  const { fetchLink, connections } = fakeNetwork({ 'http://indexer.lan:5076/getnzb/1': { body: Buffer.from(nzbXml()) } })
  for (const link of ['http://127.0.0.1/a.torrent', 'http://[::1]/a.torrent', 'http://evil.test/a.torrent', 'http://mixed.test/a.torrent', 'http://192.168.1.20:5076/getnzb/1', 'http://indexer.lan/getnzb/1', 'http://169.254.169.254/latest/meta-data']) {
    await assert.rejects(inspectSubmission({ link }, { fetchLink }), code('unsafe-link'), link)
  }
  assert.equal(connections.length, 0, 'nothing unsafe was ever connected to')
  const trusted = await inspectSubmission({ link: 'http://indexer.lan:5076/getnzb/1' }, { fetchLink })
  assert.equal(trusted.kind, 'nzb')
})

test('refuses embedded credentials, other schemes and cookie or login links', async () => {
  const { fetchLink } = fakeNetwork({
    'https://files.test/private.torrent': { status: 403, headers: {} },
    'https://files.test/login.torrent': { status: 401, headers: { 'www-authenticate': 'Basic' } },
    'https://files.test/page.torrent': { body: Buffer.from('<!DOCTYPE html><html><form>Sign in</form></html>') },
    'https://files.test/gz.torrent': { headers: { 'content-encoding': 'gzip' }, body: gzipSync(torrentBytes()) },
    'https://files.test/junk.torrent': { body: Buffer.from('not a torrent at all') },
  })
  await assert.rejects(inspectSubmission({ link: 'https://user:pass@files.test/a.torrent' }, { fetchLink }), code('unsafe-link'))
  for (const link of ['ftp://files.test/a.torrent', 'file:///etc/passwd', 'javascript:alert(1)', 'data:application/x-bittorrent;base64,ZA==']) await assert.rejects(inspectSubmission({ link }, { fetchLink }), code('invalid-link'), link)
  await assert.rejects(inspectSubmission({ link: 'https://files.test/private.torrent' }, { fetchLink }), code('auth-required'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/login.torrent' }, { fetchLink }), code('auth-required'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/page.torrent' }, { fetchLink }), code('auth-required'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/gz.torrent' }, { fetchLink }), code('invalid-link'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/junk.torrent' }, { fetchLink }), code('invalid-link'))
  await assert.rejects(inspectSubmission({ link: 'https://nowhere.test/a.torrent' }, { fetchLink }), code('fetch-failed'))
})

test('follows a few redirects, checking each one, and accepts a redirect to a magnet', async () => {
  const hex = 'c9e15763f722f23e98a29decdfae341b98d53056'
  const { fetchLink, connections } = fakeNetwork({
    'https://files.test/r1': { status: 302, headers: { location: '/r2' } },
    'https://files.test/r2': { status: 301, headers: { location: 'https://files.test/final.torrent' } },
    'https://files.test/final.torrent': { body: torrentBytes() },
    'https://files.test/to-local': { status: 302, headers: { location: 'http://127.0.0.1:8080/api/v2/app/version' } },
    'https://files.test/to-indexer-ip': { status: 302, headers: { location: 'http://evil.test/a' } },
    'https://files.test/to-creds': { status: 302, headers: { location: 'https://a:b@files.test/final.torrent' } },
    'https://files.test/to-magnet': { status: 302, headers: { location: `magnet:?xt=urn:btih:${hex}&dn=Sintel` } },
    'https://files.test/loop': { status: 302, headers: { location: '/loop' } },
  })
  assert.equal((await inspectSubmission({ link: 'https://files.test/r1' }, { fetchLink })).kind, 'torrent')
  await assert.rejects(inspectSubmission({ link: 'https://files.test/to-local' }, { fetchLink }), code('unsafe-link'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/to-indexer-ip' }, { fetchLink }), code('unsafe-link'))
  await assert.rejects(inspectSubmission({ link: 'https://files.test/to-creds' }, { fetchLink }), code('unsafe-link'))
  assert.equal((await inspectSubmission({ link: 'https://files.test/to-magnet' }, { fetchLink })).v1, hex)
  await assert.rejects(inspectSubmission({ link: 'https://files.test/loop' }, { fetchLink }), code('fetch-failed'))
  assert.ok(!connections.some((entry) => entry.address === '127.0.0.1'))
  assert.ok(connections.filter((entry) => entry.url === 'https://files.test/loop').length <= 4, 'at most three redirects are followed')
})

test('oversized responses and downloads larger than the limit are refused', async () => {
  const { fetchLink } = fakeNetwork({ 'https://files.test/huge.nzb': { body: Buffer.alloc(40 * 1024 * 1024, 0x20) } })
  await assert.rejects(inspectSubmission({ link: 'https://files.test/huge.nzb' }, { fetchLink }), code('too-large'))
  assert.equal((await inspectSubmission({ link: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056' }, { fetchLink, maxBytes: 1 })).kind, 'magnet', 'a magnet has no size until qBittorrent fetches its metadata')
  await assert.rejects(inspectSubmission({ file: { name: 'a.torrent', data: torrentBytes().toString('base64') } }, { fetchLink, maxBytes: 1000 }), code('too-large'))
})

test('uploads: exactly one of a link or a file, read from the content', async () => {
  const fetchLink = async () => { throw new Error('no network for uploads') }
  const nzb = await inspectSubmission({ file: { name: 'renamed.torrent', data: Buffer.from(nzbXml()).toString('base64') } }, { fetchLink })
  assert.equal(nzb.kind, 'nzb')
  const torrent = await inspectSubmission({ file: { name: 'x.nzb', data: torrentBytes().toString('base64') } }, { fetchLink })
  assert.equal(torrent.kind, 'torrent')
  await assert.rejects(inspectSubmission({}, { fetchLink }), code('invalid-link'))
  await assert.rejects(inspectSubmission({ link: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056', file: { name: 'a', data: 'ZA==' } }, { fetchLink }), code('invalid-link'))
  await assert.rejects(inspectSubmission({ file: { name: 'a', data: 'not base64!' } }, { fetchLink }), code('invalid-link'))
  await assert.rejects(inspectSubmission({ file: { name: 'a', data: 'A'.repeat(15 * 1024 * 1024) } }, { fetchLink }), code('too-large'))
})
