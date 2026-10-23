// Tomifin's checks for downloads it did not find itself: a pasted magnet, a direct .torrent or .nzb link, or an
// uploaded file, plus the NZB files it fetches for its own Usenet search results. Everything here is untrusted:
//   - magnets must carry a valid BitTorrent v1 (btih) and/or v2 (btmh) info hash;
//   - .torrent files are parsed as bencode with strict limits, and their info hash is worked out here;
//   - NZB files are parsed as plain XML: no DOCTYPE, entities, processing instructions or CDATA, nothing compressed;
//   - links are fetched only from public addresses (or a configured indexer's exact host), every redirect is checked
//     again, the address is pinned for the connection (no DNS rebinding), and size and time are limited.
// Nothing about a link (its URL, trackers, passkeys or API keys) is ever returned to the browser or logged.
import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_NZB_FILE_BYTES = 32 * 1024 * 1024
// Uploaded files travel base64-encoded through the Worker and the agent's 16 MiB request limit.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_LINK_LENGTH = 8000
const FETCH_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3

export class LinkError extends Error {
  constructor(code, message) { super(message); this.name = 'LinkError'; this.code = code }
}

function text(value) { return String(value ?? '').trim() }

// A name to show for a download: printable, no path, bounded.
export function displayName(value, fallback) {
  const name = text(value).normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/[\\/]/).pop().replace(/\s+/g, ' ').trim().slice(0, 300)
  return name || fallback
}

// ---------------------------------------------------------------------------------------------------------------
// Magnets

function base32ToHex(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const character of value.toUpperCase()) {
    const index = alphabet.indexOf(character)
    if (index < 0) return null
    bits += index.toString(2).padStart(5, '0')
  }
  return bits.match(/.{8}/g).map((byte) => parseInt(byte, 2).toString(16).padStart(2, '0')).join('')
}

// qBittorrent names a torrent by its v1 info hash, or by the first 40 hex digits of its v2 hash when it has no v1.
export function torrentId({ v1, v2 }) { return v1 || (v2 ? v2.slice(0, 40) : null) }

// A magnet link with one BitTorrent v1 hash (40 hex or 32 base32 characters), one v2 hash (btmh, multihash 1220 +
// 64 hex: SHA-256) or both (a hybrid). Anything else, or two different hashes of one kind, is refused.
export function parseMagnet(value) {
  const link = text(value)
  if (!/^magnet:\?/i.test(link)) throw new LinkError('invalid-link', 'That is not a magnet link.')
  if (link.length > MAX_LINK_LENGTH) throw new LinkError('invalid-link', 'The magnet link is too long.')
  if (/[\s\u0000-\u001f\u007f]/.test(link)) throw new LinkError('invalid-link', 'The magnet link has spaces or control characters in it.')
  let params
  try { params = new URLSearchParams(link.slice(link.indexOf('?') + 1)) } catch { throw new LinkError('invalid-link', 'The magnet link could not be read.') }
  const v1 = new Set()
  const v2 = new Set()
  for (const topic of params.getAll('xt')) {
    const btih = topic.match(/^urn:btih:([A-Za-z0-9]+)$/i)?.[1]
    const btmh = topic.match(/^urn:btmh:([A-Fa-f0-9]+)$/i)?.[1]
    if (btih) {
      const hex = /^[a-f0-9]{40}$/i.test(btih) ? btih.toLowerCase() : /^[a-z2-7]{32}$/i.test(btih) ? base32ToHex(btih) : null
      if (!hex) throw new LinkError('invalid-link', 'The magnet link has an invalid BitTorrent info hash.')
      v1.add(hex)
    } else if (btmh) {
      if (!/^1220[a-f0-9]{64}$/i.test(btmh)) throw new LinkError('invalid-link', 'The magnet link has an invalid BitTorrent v2 info hash.')
      v2.add(btmh.slice(4).toLowerCase())
    }
  }
  if (v1.size > 1 || v2.size > 1) throw new LinkError('invalid-link', 'The magnet link names more than one torrent.')
  if (!v1.size && !v2.size) throw new LinkError('invalid-link', 'The magnet link has no BitTorrent info hash (xt=urn:btih:… or urn:btmh:…).')
  const hashes = { v1: [...v1][0] || null, v2: [...v2][0] || null }
  const name = displayName(params.get('dn'), '') || null
  return { kind: 'magnet', link, ...hashes, id: torrentId(hashes), name }
}

// ---------------------------------------------------------------------------------------------------------------
// .torrent files (bencode)

// Decodes bencode strictly: byte strings, integers, lists and dictionaries with string keys, nesting at most 64 deep,
// nothing after the end. Strings are Buffers. Also returns where the top-level "info" value starts and ends, since
// the info hash is the hash of exactly those bytes.
export function decodeBencode(bytes, { maxDepth = 64, maxItems = 2_000_000 } = {}) {
  const data = Buffer.from(bytes)
  let position = 0
  let items = 0
  let info = null
  const fail = () => { throw new LinkError('invalid-torrent', 'That is not a valid .torrent file.') }
  function integer(end) {
    const raw = data.toString('latin1', position, end)
    if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(raw)) fail()
    position = end + 1
    return Number(raw)
  }
  function value(depth) {
    if (depth > maxDepth || ++items > maxItems || position >= data.length) fail()
    const marker = data[position]
    if (marker === 0x69) { // i<digits>e
      position += 1
      const end = data.indexOf(0x65, position)
      if (end < 0) fail()
      return integer(end)
    }
    if (marker >= 0x30 && marker <= 0x39) { // <length>:<bytes>
      const colon = data.indexOf(0x3a, position)
      if (colon < 0 || colon - position > 10) fail()
      const raw = data.toString('latin1', position, colon)
      if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) fail()
      const length = Number(raw)
      const start = colon + 1
      if (start + length > data.length) fail()
      position = start + length
      return data.subarray(start, position)
    }
    if (marker === 0x6c) { // l…e
      position += 1
      const list = []
      while (data[position] !== 0x65) { if (position >= data.length) fail(); list.push(value(depth + 1)) }
      position += 1
      return list
    }
    if (marker === 0x64) { // d…e
      position += 1
      const dictionary = new Map()
      while (data[position] !== 0x65) {
        if (position >= data.length || data[position] < 0x30 || data[position] > 0x39) fail()
        const key = value(depth + 1).toString('utf8')
        if (dictionary.has(key)) fail()
        const start = position
        dictionary.set(key, value(depth + 1))
        if (depth === 0 && key === 'info') info = { start, end: position }
      }
      position += 1
      return dictionary
    }
    return fail()
  }
  const root = value(0)
  if (position !== data.length) fail()
  return { root, info, data }
}

function safePathPart(part) {
  const name = Buffer.isBuffer(part) ? part.toString('utf8') : ''
  return Boolean(name) && name !== '.' && name !== '..' && !/[\u0000/\\]/.test(name)
}

// The parts of a .torrent file Tomifin needs: its info hashes (v1 SHA-1 and/or v2 SHA-256 of the info dictionary),
// name, total size and file count. Trackers and any passkeys in them are not read.
export function parseTorrentFile(bytes, { maxBytes = MAX_TORRENT_FILE_BYTES } = {}) {
  if (!bytes?.length || bytes.length > maxBytes) throw new LinkError('too-large', 'The .torrent file is empty or too large.')
  const { root, info: span, data } = decodeBencode(bytes)
  const fail = (message = 'That is not a valid .torrent file.') => { throw new LinkError('invalid-torrent', message) }
  if (!(root instanceof Map) || !span) fail()
  const info = root.get('info')
  if (!(info instanceof Map) || !Buffer.isBuffer(info.get('name'))) fail()
  const infoBytes = data.subarray(span.start, span.end)
  const isV2 = info.get('meta version') === 2
  const hasV1 = Buffer.isBuffer(info.get('pieces'))
  if (!isV2 && !hasV1) fail()
  if (hasV1 && (info.get('pieces').length % 20 !== 0 || !Number.isInteger(info.get('piece length')) || info.get('piece length') <= 0)) fail()
  let size = 0
  let files = 0
  const add = (length) => { if (!Number.isSafeInteger(length) || length < 0) fail(); size += length; files += 1 }
  if (hasV1) {
    if (Number.isInteger(info.get('length'))) add(info.get('length'))
    else if (Array.isArray(info.get('files'))) {
      for (const file of info.get('files')) {
        if (!(file instanceof Map) || !Array.isArray(file.get('path')) || !file.get('path').length || !file.get('path').every(safePathPart)) fail('The .torrent file has an unsafe file name.')
        add(file.get('length'))
      }
    } else fail()
  } else {
    const walk = (tree, depth) => {
      if (!(tree instanceof Map) || depth > 32) fail()
      for (const [name, node] of tree) {
        if (name === '' && node instanceof Map) { add(node.get('length')); continue }
        if (!safePathPart(Buffer.from(name))) fail('The .torrent file has an unsafe file name.')
        walk(node, depth + 1)
      }
    }
    walk(info.get('file tree'), 0)
  }
  if (!files) fail()
  if (!safePathPart(info.get('name'))) fail('The .torrent file has an unsafe name.')
  const hashes = {
    v1: hasV1 ? createHash('sha1').update(infoBytes).digest('hex') : null,
    v2: isV2 ? createHash('sha256').update(infoBytes).digest('hex') : null,
  }
  return { kind: 'torrent', ...hashes, id: torrentId(hashes), name: displayName(info.get('name').toString('utf8'), 'Torrent'), size, files, private: info.get('private') === 1 }
}

// ---------------------------------------------------------------------------------------------------------------
// NZB files (XML)

const COMPRESSED = [[0x1f, 0x8b], [0x50, 0x4b, 0x03, 0x04], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], [0x28, 0xb5, 0x2f, 0xfd]]
function startsWith(bytes, signature) { return signature.every((byte, index) => bytes[index] === byte) }

const XML_NAME = /^[A-Za-z_][A-Za-z0-9._:-]*$/
function decodeReferences(value) {
  return value.replace(/&([^;&\s]{0,12});/g, (whole, name) => {
    if (name === 'lt') return '<'
    if (name === 'gt') return '>'
    if (name === 'amp') return '&'
    if (name === 'quot') return '"'
    if (name === 'apos') return '\''
    const code = /^#x[0-9a-f]{1,6}$/i.test(name) ? parseInt(name.slice(2), 16) : /^#[0-9]{1,7}$/.test(name) ? Number(name.slice(1)) : NaN
    if (!Number.isInteger(code) || code < 0x20 && ![0x9, 0xa, 0xd].includes(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new LinkError('invalid-nzb', 'The NZB file has an entity or character reference that is not allowed.')
    return String.fromCodePoint(code)
  })
}
function checkText(value) {
  if (/&(?![a-z]{2,4};|#[0-9]{1,7};|#x[0-9a-f]{1,6};)/i.test(value)) throw new LinkError('invalid-nzb', 'The NZB file has a stray "&".')
  return decodeReferences(value)
}

// A small, strict XML reader: elements, attributes, text and comments only. Anything that could declare or expand
// entities (a DOCTYPE), processing instructions after the declaration, CDATA and malformed nesting are refused.
// The encodings NZB files are found in: UTF-8 (with or without a BOM), plain ASCII, ISO-8859-1/Windows-1252 (common:
// older tools and some indexers declare it), ISO-8859-15, and UTF-16 with a BOM. Each maps to a WHATWG decoder label.
const NZB_ENCODINGS = new Map([
  ['utf-8', 'utf-8'], ['utf8', 'utf-8'], ['us-ascii', 'utf-8'], ['ascii', 'utf-8'],
  ['iso-8859-1', 'latin1'], ['iso8859-1', 'latin1'], ['latin1', 'latin1'], ['latin-1', 'latin1'], ['windows-1252', 'latin1'], ['cp1252', 'latin1'],
  ['iso-8859-15', 'iso-8859-15'], ['latin-9', 'iso-8859-15'],
])
const UNSUPPORTED_ENCODING = 'The NZB file uses an unsupported character encoding (UTF-8, ASCII, ISO-8859-1/Windows-1252, ISO-8859-15 or UTF-16 are accepted).'

// Bytes to text, from the BOM or the XML declaration's encoding (UTF-8 when there is neither). UTF-8 must be valid.
export function decodeNzbText(bytes) {
  const data = Buffer.from(bytes)
  const fail = (message = UNSUPPORTED_ENCODING) => { throw new LinkError('invalid-nzb', message) }
  const decode = (label, body, fatal = false) => { try { return new TextDecoder(label, { fatal, ignoreBOM: true }).decode(body) } catch { return fail(fatal ? 'The NZB file is not valid UTF-8 text.' : UNSUPPORTED_ENCODING) } }
  let text
  let assumed
  if (data[0] === 0xff && data[1] === 0xfe) { text = decode('utf-16le', data.subarray(2)); assumed = 'utf-16' }
  else if (data[0] === 0xfe && data[1] === 0xff) {
    // Swapped to little-endian, which every Node build can decode.
    const body = Buffer.from(data.subarray(2, data.length - (data.length % 2)))
    body.swap16()
    text = decode('utf-16le', body); assumed = 'utf-16'
  } else {
    const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
    const body = bom ? data.subarray(3) : data
    const declared = body.subarray(0, 256).toString('latin1').match(/^\s*<\?xml\s[^?<>]*?encoding\s*=\s*["']([^"']{1,40})["']/i)?.[1]?.toLowerCase()
    const label = declared ? NZB_ENCODINGS.get(declared) : 'utf-8'
    if (!label || (bom && label !== 'utf-8')) fail()
    text = decode(label, body, label === 'utf-8')
    assumed = label
  }
  const declared = text.match(/^\s*<\?xml\s[^?<>]*?encoding\s*=\s*["']([^"']{1,40})["']/i)?.[1]?.toLowerCase()
  if (assumed === 'utf-16' && declared && !/^utf-?16(?:le|be)?$/.test(declared)) fail()
  return text
}

// The one DOCTYPE real NZB files carry: newzBin's public identifier with an external DTD and no internal subset. It
// declares no entities, and nothing here (or in SABnzbd) loads the DTD, so it is skipped. Any other DOCTYPE is refused.
const NZB_DOCTYPE = /^\s*<!DOCTYPE\s+nzb\s+PUBLIC\s+"-\/\/newzBin\/\/DTD NZB 1\.[01]\/\/EN"\s+"https?:\/\/www\.newzbin\.com\/DTD\/(?:2003\/nzb|nzb\/nzb-1\.[01]\.dtd)"\s*>/i

export function readXml(source, { onOpen, onText, onClose, maxElements = 2_000_000 }) {
  const fail = (message = 'The NZB file is not well-formed XML.') => { throw new LinkError('invalid-nzb', message) }
  let xml = source.startsWith('﻿') ? source.slice(1) : source
  const declaration = xml.match(/^\s*<\?xml\s[^?<>]*\?>/)
  if (declaration) {
    const encoding = declaration[0].match(/encoding\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase()
    if (encoding && !NZB_ENCODINGS.has(encoding) && !/^utf-?16(?:le|be)?$/.test(encoding)) fail(UNSUPPORTED_ENCODING)
    xml = xml.slice(declaration[0].length)
  }
  const doctype = xml.match(NZB_DOCTYPE)
  if (doctype) xml = xml.slice(doctype[0].length)
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?/i.test(xml)) fail('The NZB file has a DOCTYPE, entity, CDATA or processing instruction, which are not accepted.')
  const stack = []
  let roots = 0
  let elements = 0
  let position = 0
  while (position < xml.length) {
    const open = xml.indexOf('<', position)
    const textEnd = open < 0 ? xml.length : open
    if (textEnd > position) {
      const chunk = xml.slice(position, textEnd)
      if (!stack.length) { if (chunk.trim()) fail(); } else onText?.(checkText(chunk), stack)
    }
    if (open < 0) break
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4)
      if (end < 0) fail()
      position = end + 3
      continue
    }
    const close = xml.indexOf('>', open)
    if (close < 0) fail()
    const tag = xml.slice(open + 1, close)
    position = close + 1
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim()
      if (stack.pop() !== name) fail()
      onClose?.(name, stack)
      continue
    }
    const selfClosing = tag.endsWith('/')
    const body = selfClosing ? tag.slice(0, -1) : tag
    const name = body.match(/^[^\s/]+/)?.[0] || ''
    if (!XML_NAME.test(name)) fail()
    if (!stack.length && ++roots > 1) fail()
    if (++elements > maxElements) fail('The NZB file is too large.')
    const attributes = {}
    let rest = body.slice(name.length)
    const attribute = /^\s+([A-Za-z_][A-Za-z0-9._:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/
    for (let match = rest.match(attribute); match; match = rest.match(attribute)) {
      if (Object.hasOwn(attributes, match[1])) fail()
      attributes[match[1]] = checkText(match[2] ?? match[3])
      rest = rest.slice(match[0].length)
    }
    if (rest.trim()) fail()
    onOpen?.(name, attributes, stack)
    if (selfClosing) onClose?.(name, stack)
    else stack.push(name)
  }
  if (stack.length || roots !== 1) fail()
}

const local = (name) => name.replace(/^[^:]*:/, '').toLowerCase()

// Checks that bytes are an NZB file and reads what Tomifin needs: a display name (never a path from inside it), the
// number of files and segments, their total size, and an identity that does not depend on formatting: the SHA-256
// of the sorted, distinct message-ids of every segment. Two NZBs for the same posts have the same identity.
export function parseNzb(bytes, { maxBytes = MAX_NZB_FILE_BYTES, fallbackName = 'NZB download' } = {}) {
  if (!bytes?.length || bytes.length > maxBytes) throw new LinkError('too-large', 'The NZB file is empty or too large.')
  if (COMPRESSED.some((signature) => startsWith(bytes, signature))) throw new LinkError('invalid-nzb', 'Compressed NZB files are not accepted.')
  let source
  source = decodeNzbText(bytes)
  let rootName = null
  const meta = {}
  let metaType = null
  let files = 0
  let segments = 0
  let total = 0
  let groups = 0
  let firstSubject = null
  let current = null
  const ids = new Set()
  readXml(source, {
    onOpen(name, attributes, stack) {
      const element = local(name)
      if (!stack.length) { rootName = element; return }
      if (element === 'meta' && local(stack.at(-1)) === 'head') metaType = text(attributes.type).toLowerCase()
      if (element === 'file') { files += 1; current = { segments: 0, groups: 0 }; firstSubject ??= text(attributes.subject) }
      if (element === 'segment') {
        const size = Number(attributes.bytes)
        if (!current || !Number.isSafeInteger(size) || size <= 0) throw new LinkError('invalid-nzb', 'The NZB file has a segment without a valid size.')
        segments += 1; current.segments += 1; total += size
        current.id = ''
      }
      if (element === 'group' && current) { current.groups += 1; groups += 1 }
    },
    onText(value, stack) {
      const element = local(stack.at(-1))
      if (element === 'segment' && current) current.id += value
      if (element === 'meta' && metaType) meta[metaType] = (meta[metaType] || '') + value
    },
    onClose(name) {
      const element = local(name)
      if (element === 'segment' && current) {
        const id = text(current.id).replace(/^<|>$/g, '')
        if (!id || id.length > 500 || /[\s<>]/.test(id)) throw new LinkError('invalid-nzb', 'The NZB file has a segment without a valid message-id.')
        ids.add(id)
      }
      if (element === 'meta') metaType = null
      if (element === 'file' && current) {
        if (!current.segments || !current.groups) throw new LinkError('invalid-nzb', 'The NZB file lists a file with no segments or newsgroups.')
        current = null
      }
    },
  })
  if (rootName !== 'nzb') throw new LinkError('invalid-nzb', 'That is not an NZB file.')
  if (!files || !segments) throw new LinkError('invalid-nzb', 'The NZB file lists no files.')
  if (text(meta.password)) throw new LinkError('password-protected', 'This NZB needs a password, which Tomifin does not support.')
  const quoted = firstSubject?.match(/"([^"]+)"/)?.[1]
  const fromSubject = quoted ? quoted.replace(/(?:\.(?:part\d+|vol\d+\+\d+))?\.(?:rar|r\d{2}|par2|nzb|zip|7z|\d{3}|mkv|mp4|avi)$/i, '') : null
  const name = displayName(meta.name || meta.title || fromSubject, fallbackName)
  const identity = createHash('sha256').update([...ids].sort().join('\n')).digest('hex')
  return { kind: 'nzb', name, files, segments, size: total, groups, identity, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// What some bytes are, from their content alone (never a file name or content type): 'torrent', 'nzb' or null.
export function detectPayload(bytes) {
  if (!bytes?.length) return null
  if (bytes[0] === 0x64) return 'torrent'
  const raw = Buffer.from(bytes.subarray(0, 8192))
  let head
  if (raw[0] === 0xff && raw[1] === 0xfe) head = raw.subarray(2, raw.length - (raw.length % 2)).toString('utf16le')
  else if (raw[0] === 0xfe && raw[1] === 0xff) { const swapped = Buffer.from(raw.subarray(2, raw.length - (raw.length % 2))); swapped.swap16(); head = swapped.toString('utf16le') }
  else head = raw.toString('latin1')
  head = head.replace(/^\ufeff/, '').replace(/^\u00ef\u00bb\u00bf/, '').trimStart()
  if (head.startsWith('<')) return /<(?:[A-Za-z_][\w.-]*:)?nzb[\s>]/i.test(head) ? 'nzb' : /<html|<!doctype\s+html/i.test(head) ? 'html' : 'xml'
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Fetching links safely

// Two lists: Node's BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules, so one list holding ::ffff:0:0/96
// would block every IPv4 address.
const blocked4 = new BlockList()
const blocked6 = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked6.addSubnet(network, prefix, 'ipv6')

// True for any address a link must not reach: loopback, private, link-local, carrier-grade NAT, documentation,
// multicast, reserved, and IPv6 forms that can wrap an IPv4 address (mapped, NAT64, 6to4, Teredo).
export function unsafeAddress(address) {
  const value = text(address).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const family = isIP(value)
  if (!family) return true
  return family === 4 ? blocked4.check(value, 'ipv4') : blocked6.check(value, 'ipv6')
}

function linkUrl(value) {
  let url
  try { url = new URL(text(value)) } catch { throw new LinkError('invalid-link', 'Paste a magnet link, or an http(s) link to a .torrent or .nzb file.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new LinkError('invalid-link', 'Only magnet links and http(s) links are accepted.')
  if (url.username || url.password) throw new LinkError('unsafe-link', 'Links with a username or password in them are not accepted.')
  if (!url.hostname) throw new LinkError('invalid-link', 'That link has no host.')
  url.hash = ''
  return url
}

// Node's http(s) client with the connection pinned to an address already checked, so DNS cannot change between the
// check and the connection. Sends no cookies or credentials and asks for an uncompressed answer.
export function nodeTransport(url, { address, family, timeoutMs, maxBytes }) {
  return new Promise((resolvePromise, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: 'GET', servername: isIP(url.hostname) ? undefined : url.hostname,
      headers: { 'user-agent': 'Tomify/0.1 recovery-agent', accept: '*/*', 'accept-encoding': 'identity' },
      lookup: (_hostname, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
      timeout: timeoutMs,
    }, (response) => {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]))
      const status = response.statusCode || 0
      if (status >= 300 && status < 400) { response.resume(); resolvePromise({ status, headers, body: Buffer.alloc(0) }); return }
      const declared = Number(headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) { response.destroy(); reject(new LinkError('too-large', 'The linked file is too large.')); return }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) { response.destroy(); reject(new LinkError('too-large', 'The linked file is too large.')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolvePromise({ status, headers, body: Buffer.concat(chunks) }))
      response.on('error', () => reject(new LinkError('fetch-failed', 'The link could not be downloaded.')))
    })
    const timer = setTimeout(() => request.destroy(new LinkError('fetch-failed', 'The link took too long to answer.')), timeoutMs)
    request.on('timeout', () => request.destroy(new LinkError('fetch-failed', 'The link took too long to answer.')))
    request.on('error', (error) => reject(error instanceof LinkError ? error : new LinkError('fetch-failed', 'The link could not be downloaded.')))
    request.on('close', () => clearTimeout(timer))
    request.end()
  })
}

// trustedHosts: exact host[:port] values of configured indexers, which may be on a private address. Every other host
// must resolve only to public addresses. Returns { bytes } or, for a redirect to a magnet, { magnet }.
export function createLinkFetcher({ trustedHosts = [], resolveHost = (host) => dnsLookup(host, { all: true, verbatim: true }), transport = nodeTransport, timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, now = Date.now } = {}) {
  const trusted = new Set(trustedHosts.map((host) => text(host).toLowerCase()).filter(Boolean))
  return async function fetchLink(value, { maxBytes }) {
    const deadline = now() + timeoutMs
    let url = linkUrl(value)
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      const isTrusted = trusted.has(url.host.toLowerCase())
      let addresses
      if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
      else {
        try { addresses = await resolveHost(host) } catch { throw new LinkError('fetch-failed', 'The link\'s host could not be found.') }
      }
      if (!addresses?.length) throw new LinkError('fetch-failed', 'The link\'s host could not be found.')
      if (!isTrusted && addresses.some((entry) => unsafeAddress(entry.address))) throw new LinkError('unsafe-link', 'Links to private or local network addresses are not accepted.')
      const remaining = deadline - now()
      if (remaining <= 0) throw new LinkError('fetch-failed', 'The link took too long to answer.')
      const response = await transport(url, { address: addresses[0].address, family: addresses[0].family || isIP(addresses[0].address), timeoutMs: remaining, maxBytes })
      if (response.status >= 300 && response.status < 400) {
        const location = text(response.headers.location)
        if (/^magnet:\?/i.test(location)) return { magnet: location }
        if (!location) throw new LinkError('fetch-failed', 'The link redirected nowhere.')
        let next
        try { next = new URL(location, url) } catch { throw new LinkError('fetch-failed', 'The link redirected to an invalid address.') }
        url = linkUrl(next.toString())
        continue
      }
      if ([401, 403, 407].includes(response.status) || response.headers['www-authenticate']) throw new LinkError('auth-required', 'That link needs a sign-in or cookies, which Tomifin does not send. Download the file and upload it instead.')
      if (response.status < 200 || response.status >= 300) throw new LinkError('fetch-failed', `The link answered HTTP ${response.status}.`)
      const encoding = text(response.headers['content-encoding']).toLowerCase()
      if (encoding && encoding !== 'identity') throw new LinkError('invalid-link', 'The linked file was sent compressed, which is not accepted.')
      if (response.body.length > maxBytes) throw new LinkError('too-large', 'The linked file is too large.')
      return { bytes: response.body }
    }
    throw new LinkError('fetch-failed', 'The link redirected too many times.')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One submission from the Add link form

// Exactly one of link (a magnet, or an http(s) link to a .torrent or .nzb file) or file ({ name, data: base64 }).
// Detects what it is from its content (never from a name, extension or content type) and checks it fully.
// Returns { kind: 'magnet' | 'torrent' | 'nzb', …details, bytes? }.
export async function inspectSubmission({ link, file }, { fetchLink, maxBytes = Number.POSITIVE_INFINITY }) {
  const hasLink = typeof link === 'string' && text(link) !== ''
  const hasFile = file && typeof file === 'object' && typeof file.data === 'string'
  if (hasLink === Boolean(hasFile)) throw new LinkError('invalid-link', 'Paste one link, or choose one .torrent or .nzb file.')
  let bytes
  let fallback
  if (hasFile) {
    if (file.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) throw new LinkError('too-large', 'That file is too large to upload (10 MiB at most).')
    if (!file.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new LinkError('invalid-link', 'That file could not be read.')
    bytes = Buffer.from(file.data, 'base64')
    fallback = displayName(text(file.name).replace(/\.(?:torrent|nzb)$/i, ''), 'Uploaded file')
  } else {
    const value = text(link)
    if (value.length > MAX_LINK_LENGTH) throw new LinkError('invalid-link', 'The link is too long.')
    if (/^magnet:/i.test(value)) return checkSize(parseMagnet(value), maxBytes)
    const fetched = await fetchLink(value, { maxBytes: MAX_NZB_FILE_BYTES })
    if (fetched.magnet) return checkSize(parseMagnet(fetched.magnet), maxBytes)
    bytes = fetched.bytes
    try { fallback = displayName(decodeURIComponent(new URL(value).pathname.split('/').pop() || '').replace(/\.(?:torrent|nzb)$/i, ''), 'Linked file') } catch { fallback = 'Linked file' }
  }
  const type = detectPayload(bytes)
  if (type === 'torrent') return checkSize({ ...parseTorrentFile(bytes), bytes }, maxBytes)
  if (type === 'nzb') return checkSize({ ...parseNzb(bytes, { fallbackName: fallback }), bytes }, maxBytes)
  if (type === 'html') throw new LinkError('auth-required', 'That link opens a web page, not a .torrent or .nzb file. It may need a sign-in; download the file and upload it instead.')
  throw new LinkError('invalid-link', 'That is not a magnet link, a .torrent file or an NZB file.')
}

function checkSize(parsed, maxBytes) {
  if (parsed.size && parsed.size > maxBytes) throw new LinkError('too-large', 'This download is larger than the download limit (TOMIFY_TOMIFIN_MAX_BYTES).')
  return parsed
}
