import { isIP } from 'node:net'

// Torrent indexers searched alongside qBittorrent's search plugins: a Prowlarr instance (its own search API covers
// every indexer it has) or any Torznab feed, such as Jackett's "all indexers" feed or one Prowlarr indexer.
// Results are returned in the shape of qBittorrent search-plugin results so torrentSearchCandidates handles both.

const TORRENT_CATEGORY = '3000'
const INDEXER_TIMEOUT_MS = 25_000
const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
// Stands in for the indexer's API key in download links that are stored with a Recovery candidate.
export const INDEXER_KEY_PLACEHOLDER = 'tomify-indexer-key'

function text(value) { return String(value ?? '').trim() }
function number(value) { if (value === null || value === undefined || text(value) === '') return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function decodeXml(value) { return text(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }
function xmlTag(value, tag) { return decodeXml(value.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'))?.[1]) }
function xmlAttr(value, name) { return decodeXml(value.match(new RegExp(`<torznab:attr\\s+[^>]*name=["']${name}["'][^>]*value=["']([^"']*)`, 'i'))?.[1]) }
function enclosureAttr(value, name) { return decodeXml(value.match(new RegExp(`<enclosure\\s+[^>]*${name}=["']([^"']*)`, 'i'))?.[1]) }
function loopback(hostname) { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) }

function publicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  const version = isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
  }
  if (version === 6) return !(host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:'))
  return true
}

export function parseTorrentIndexers(raw) {
  if (!text(raw)) return []
  let values
  try { values = JSON.parse(raw) } catch { throw new Error('TOMIFY_TORRENT_INDEXERS_JSON must be valid JSON.') }
  if (!Array.isArray(values)) throw new Error('TOMIFY_TORRENT_INDEXERS_JSON must be a JSON array.')
  return values.map((value, index) => {
    const type = text(value?.type || 'torznab').toLowerCase()
    if (!['prowlarr', 'torznab'].includes(type)) throw new Error(`Torrent indexer ${index + 1} has an unknown type (use "prowlarr" or "torznab").`)
    const id = text(value?.id || `${type}-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    const name = text(value?.name || (type === 'prowlarr' ? 'Prowlarr' : id)).slice(0, 120)
    let url
    try { url = new URL(text(value?.url)) } catch { throw new Error(`Torrent indexer ${name} needs a url.`) }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw new Error(`Torrent indexer ${name} must use HTTPS (or loopback HTTP).`)
    if (url.username || url.password) throw new Error(`Torrent indexer ${name} must not have a username or password in its url.`)
    const apiKey = text(value?.apiKey)
    if (!id || !apiKey) throw new Error(`Torrent indexer ${name} is missing an id or apiKey.`)
    return { id, type, name, url: url.toString().replace(/\/$/, ''), origin: url.origin, apiKey, categories: text(value?.categories || TORRENT_CATEGORY) }
  })
}

let envIndexers = null
// The indexers configured in the agent's environment, parsed once.
export function configuredTorrentIndexers(env = process.env) {
  if (env !== process.env) return parseTorrentIndexers(env.TOMIFY_TORRENT_INDEXERS_JSON)
  envIndexers ??= parseTorrentIndexers(env.TOMIFY_TORRENT_INDEXERS_JSON)
  return envIndexers
}

function indexerFor(link, indexers) {
  let url
  try { url = new URL(text(link)) } catch { return null }
  return indexers.find((indexer) => indexer.origin === url.origin) || null
}

// True for a download link served by a configured indexer, which may be on a loopback address.
export function isIndexerLink(link, indexers = configuredTorrentIndexers()) {
  return Boolean(indexerFor(link, indexers))
}

// Download links from Prowlarr and Jackett carry the API key. It is swapped for a placeholder before the link is
// stored with a candidate, and put back only when the agent fetches the torrent.
export function storableIndexerLink(link, indexer) {
  const url = new URL(link)
  for (const [key, value] of [...url.searchParams]) if (value === indexer.apiKey) url.searchParams.set(key, INDEXER_KEY_PLACEHOLDER)
  return url.toString()
}

function authorisedIndexerLink(link, indexer) {
  const url = new URL(link)
  for (const [key, value] of [...url.searchParams]) if (value === INDEXER_KEY_PLACEHOLDER) url.searchParams.set(key, indexer.apiKey)
  return url
}

function detailsLink(value) {
  try {
    const url = new URL(text(value))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !publicHost(url.hostname)) return null
    for (const key of [...url.searchParams.keys()]) if (/api.?key|token|password|passkey/i.test(key)) url.searchParams.delete(key)
    return url.toString()
  } catch { return null }
}

// The best link for one result: a magnet when the indexer gives one, otherwise its download link.
function resultLink({ magnet, download, infoHash, title }, indexer) {
  for (const value of [magnet, download]) {
    const link = text(value)
    if (/^magnet:\?/i.test(link)) return link
    if (/^https?:/i.test(link)) return indexerFor(link, [indexer]) ? storableIndexerLink(link, indexer) : link
  }
  if (/^[a-f0-9]{40}$/i.test(text(infoHash))) return `magnet:?xt=urn:btih:${text(infoHash).toLowerCase()}${title ? `&dn=${encodeURIComponent(title)}` : ''}`
  return null
}

export function parseTorznabResults(xml, indexer) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || []
  return items.map((item) => {
    const title = xmlTag(item, 'title')
    const fileUrl = resultLink({ magnet: xmlAttr(item, 'magneturl'), download: enclosureAttr(item, 'url') || xmlTag(item, 'link'), infoHash: xmlAttr(item, 'infohash'), title }, indexer)
    if (!title || !fileUrl) return null
    const seeds = number(xmlAttr(item, 'seeders'))
    const peers = number(xmlAttr(item, 'peers'))
    const site = text(xmlTag(item, 'jackettindexer') || xmlTag(item, 'prowlarrindexer')) || indexer.name
    return {
      fileName: title, fileUrl, fileSize: number(xmlTag(item, 'size') || xmlAttr(item, 'size') || enclosureAttr(item, 'length')),
      // Torznab's peers attribute counts seeders too.
      nbSeeders: seeds === null ? -1 : seeds, nbLeechers: seeds !== null && peers !== null ? Math.max(0, peers - seeds) : -1,
      siteName: site, siteUrl: null, descrLink: detailsLink(xmlTag(item, 'comments')) || detailsLink(xmlTag(item, 'guid')), indexerId: indexer.id,
    }
  }).filter(Boolean)
}

export function parseProwlarrResults(values, indexer) {
  return (Array.isArray(values) ? values : []).map((value) => {
    if (text(value?.protocol) && text(value.protocol) !== 'torrent') return null
    const title = text(value?.title)
    const fileUrl = resultLink({ magnet: value?.magnetUrl, download: value?.downloadUrl, infoHash: value?.infoHash, title }, indexer)
    if (!title || !fileUrl) return null
    const seeds = number(value?.seeders)
    const leechers = number(value?.leechers)
    return {
      fileName: title, fileUrl, fileSize: number(value?.size), nbSeeders: seeds === null ? -1 : seeds, nbLeechers: leechers === null ? -1 : leechers,
      siteName: text(value?.indexer).slice(0, 120) || indexer.name, siteUrl: null, descrLink: detailsLink(value?.infoUrl) || detailsLink(value?.commentUrl), indexerId: indexer.id,
    }
  }).filter(Boolean)
}

async function searchOne(indexer, pattern, fetchImpl, timeoutMs) {
  const headers = { 'user-agent': 'Tomify/0.1 recovery-agent' }
  if (indexer.type === 'prowlarr') {
    const url = new URL(`${indexer.url}/api/v1/search`)
    url.searchParams.set('query', pattern); url.searchParams.set('type', 'search'); url.searchParams.set('limit', '100')
    for (const category of indexer.categories.split(',').map(text).filter(Boolean)) url.searchParams.append('categories', category)
    const response = await fetchImpl(url, { headers: { ...headers, accept: 'application/json', 'x-api-key': indexer.apiKey }, signal: AbortSignal.timeout(timeoutMs) })
    if (response.status === 401) throw new Error(`${indexer.name} rejected the configured API key.`)
    if (!response.ok) throw new Error(`${indexer.name} returned HTTP ${response.status}.`)
    return parseProwlarrResults(await response.json(), indexer)
  }
  const url = new URL(indexer.url)
  if (!url.pathname.replace(/\/$/, '').endsWith('/api')) url.pathname = `${url.pathname.replace(/\/$/, '')}/api`
  url.searchParams.set('t', 'search'); url.searchParams.set('q', pattern); url.searchParams.set('cat', indexer.categories); url.searchParams.set('limit', '100'); url.searchParams.set('apikey', indexer.apiKey)
  const response = await fetchImpl(url, { headers: { ...headers, accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 401) throw new Error(`${indexer.name} rejected the configured API key.`)
  if (!response.ok) throw new Error(`${indexer.name} returned HTTP ${response.status}.`)
  const body = await response.text()
  const error = body.match(/<error\s+[^>]*description=["']([^"']*)/i)?.[1]
  if (error) throw new Error(`${indexer.name}: ${decodeXml(error).slice(0, 200)}`)
  return parseTorznabResults(body, indexer)
}

// Searches every configured indexer at once. One failing indexer does not hide the others' results; the search
// fails only when all of them do.
export async function searchTorrentIndexers(indexers, pattern, { fetchImpl = fetch, timeoutMs = INDEXER_TIMEOUT_MS } = {}) {
  const settled = await Promise.allSettled(indexers.map((indexer) => searchOne(indexer, pattern, fetchImpl, timeoutMs)))
  if (settled.length && settled.every((result) => result.status === 'rejected')) throw settled[0].reason
  return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}

// Fetches an indexer download link for qBittorrent. Indexers either redirect to a magnet or serve the .torrent
// file; Prowlarr and Jackett often run on loopback, where qBittorrent (bound to the VPN interface) cannot reach.
// Returns { magnet } or { torrent: Uint8Array }.
export async function fetchIndexerTorrent(link, indexers = configuredTorrentIndexers(), fetchImpl = fetch) {
  const indexer = indexerFor(link, indexers)
  if (!indexer) throw new Error('The torrent link is not from a configured indexer.')
  let url = authorisedIndexerLink(link, indexer)
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': 'Tomify/0.1 recovery-agent' }, signal: AbortSignal.timeout(60_000) })
    if (response.status >= 300 && response.status < 400) {
      const location = text(response.headers.get('location'))
      if (/^magnet:\?/i.test(location)) return { magnet: location }
      let next
      try { next = new URL(location, url) } catch { throw new Error(`${indexer.name} redirected to an invalid link.`) }
      // Only the indexer itself may be on a private address.
      if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password || (next.origin !== indexer.origin && !publicHost(next.hostname))) throw new Error(`${indexer.name} redirected to an unsafe link.`)
      url = next
      continue
    }
    if (!response.ok) throw new Error(`${indexer.name} could not supply the torrent (HTTP ${response.status}); the result may have been removed.`)
    const declared = number(response.headers.get('content-length'))
    if (declared !== null && declared > MAX_TORRENT_FILE_BYTES) throw new Error(`${indexer.name} returned a torrent file that is too large.`)
    const torrent = new Uint8Array(await response.arrayBuffer())
    if (torrent.byteLength > MAX_TORRENT_FILE_BYTES) throw new Error(`${indexer.name} returned a torrent file that is too large.`)
    // A .torrent file is a bencoded dictionary.
    if (torrent[0] !== 0x64) throw new Error(`${indexer.name} did not return a torrent file.`)
    return { torrent }
  }
  throw new Error(`${indexer.name} redirected too many times.`)
}
