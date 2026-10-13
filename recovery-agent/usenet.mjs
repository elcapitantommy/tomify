import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.mka', '.wma', '.webm'])
const NZBINDEX_API_URL = 'https://api.nzbindex.com'
const NZBINDEX_SITE_URL = 'https://www.nzbindex.com'

function text(value) { return String(value ?? '').trim() }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function decodeXml(value) { return text(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }
function xmlTag(value, tag) { return decodeXml(value.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'))?.[1]) }
function xmlAttr(value, name) { return decodeXml(value.match(new RegExp(`<newznab:attr\\s+[^>]*name=["']${name}["'][^>]*value=["']([^"']*)`, 'i'))?.[1]) }
function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }
function apiEndpoint(base) { const url = new URL(base); if (!url.pathname.replace(/\/$/, '').endsWith('/api')) url.pathname = `${url.pathname.replace(/\/$/, '')}/api`; return url }
function serviceUrl(value, label) {
  const url = new URL(text(value))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) throw new Error(`${label} must use HTTPS (or loopback HTTP).`)
  return url.toString().replace(/\/$/, '')
}

export function parseIndexerConfig(raw) {
  if (!text(raw)) return []
  let values
  try { values = JSON.parse(raw) } catch { throw new Error('TOMIFY_NEWZNAB_INDEXERS_JSON must be valid JSON.') }
  if (!Array.isArray(values)) throw new Error('TOMIFY_NEWZNAB_INDEXERS_JSON must be a JSON array.')
  return values.map((value, index) => {
    const id = text(value?.id || `indexer-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    const name = text(value?.name || id).slice(0, 120)
    const url = new URL(text(value?.url))
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) throw new Error(`Newznab indexer ${name} must use HTTPS (or loopback HTTP).`)
    const apiKey = text(value?.apiKey)
    if (!id || !apiKey) throw new Error(`Newznab indexer ${name} is missing an id or apiKey.`)
    return { id, name, url: url.toString().replace(/\/$/, ''), apiKey, categories: text(value?.categories || '3000') }
  })
}

export function nzbIndexConfig(env = process.env) {
  const apiKey = text(env.TOMIFY_NZBINDEX_API_KEY)
  return { type: 'nzbindex', id: 'nzbindex', name: 'NZBIndex', apiKey, apiUrl: NZBINDEX_API_URL, siteUrl: NZBINDEX_SITE_URL }
}

export function usenetCapability({ newznabIndexers = [], nzbIndex = null, downloader = null, downloadRoot = null } = {}) {
  const providerCount = newznabIndexers.length + (nzbIndex ? 1 : 0)
  return { available: Boolean(providerCount && downloader && downloadRoot), providerCount }
}

export function usenetSearchQuery(track, mode) {
  const selected = mode === 'artist' ? text(track?.artist) : mode === 'release' ? text(track?.album) : mode === 'track' ? text(track?.title) : ''
  if (!selected) throw new Error(`A ${mode === 'release' ? 'release/album' : mode} value is required for this search mode.`)
  return selected.slice(0, 240)
}

export function parseNewznabResults(xml, indexer, mode) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || []
  return items.slice(0, 40).map((item) => {
    const title = xmlTag(item, 'title')
    const rawGuid = xmlTag(item, 'guid') || xmlTag(item, 'link')
    let guid = rawGuid
    try { const parsed = new URL(rawGuid); guid = parsed.searchParams.get('id') || basename(parsed.pathname) } catch { /* Newznab GUIDs are commonly opaque identifiers. */ }
    guid = text(guid).slice(0, 500)
    const detailsValue = xmlTag(item, 'comments')
    let detailsUrl = indexer.url
    try {
      const parsed = new URL(detailsValue)
      if (['http:', 'https:'].includes(parsed.protocol)) {
        for (const key of [...parsed.searchParams.keys()]) if (/api.?key|token|password|passkey/i.test(key)) parsed.searchParams.delete(key)
        detailsUrl = parsed.toString()
      }
    } catch { /* Provider did not supply a browsable details URL. */ }
    const size = number(xmlAttr(item, 'size') || xmlTag(item, 'size') || xmlTag(item, 'enclosure')?.match(/length=["'](\d+)/i)?.[1])
    const ageDays = number(xmlAttr(item, 'usenetdate') ? (Date.now() - Date.parse(xmlAttr(item, 'usenetdate'))) / 86400000 : null)
    if (!title || !guid) return null
    return {
      externalId: createHash('sha256').update(`${indexer.id}\0${guid}`).digest('hex'), url: detailsUrl,
      title, channel: indexer.name, duration: null, thumbnail: null,
      provenance: { providerType: 'newznab', providerId: indexer.id, providerName: indexer.name, resultId: guid, guid, postedTitle: title, searchMode: mode, size, ageDays, detailsUrl, categories: xmlAttr(item, 'category') || null },
    }
  }).filter(Boolean)
}

export async function searchNewznab(indexers, track, mode, fetchImpl = fetch) {
  const query = usenetSearchQuery(track, mode)
  const settled = await Promise.allSettled(indexers.map(async (indexer) => {
    const url = apiEndpoint(indexer.url)
    url.searchParams.set('t', 'search'); url.searchParams.set('q', query); url.searchParams.set('cat', indexer.categories); url.searchParams.set('limit', '40'); url.searchParams.set('o', 'xml'); url.searchParams.set('apikey', indexer.apiKey)
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Tomify/0.1 recovery-agent' } })
    if (!response.ok) throw new Error(`${indexer.name} returned HTTP ${response.status}.`)
    return parseNewznabResults(await response.text(), indexer, mode)
  }))
  const results = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  if (!results.length && settled.length && settled.every((result) => result.status === 'rejected')) throw settled[0].reason
  return results.slice(0, 40)
}

export function newznabDownloadUrl(indexer, guid) {
  const url = apiEndpoint(indexer.url)
  url.searchParams.set('t', 'get'); url.searchParams.set('id', text(guid)); url.searchParams.set('apikey', indexer.apiKey)
  return url.toString()
}

export function nzbIndexSearchUrl(config, track, mode) {
  const url = new URL('/api/search', config.apiUrl)
  url.searchParams.set('q', usenetSearchQuery(track, mode))
  url.searchParams.set('max', '40')
  url.searchParams.set('sort', 'agedesc')
  if (text(config.apiKey)) url.searchParams.set('key', text(config.apiKey))
  return url
}

export function parseNzbIndexResults(payload, config, mode, now = Date.now()) {
  if (payload?.error) throw new Error(`NZBIndex search failed${payload.errorMessage ? `: ${text(payload.errorMessage).slice(0, 240)}` : '.'}`)
  const collections = Array.isArray(payload?.data?.content) ? payload.data.content : []
  return collections.slice(0, 40).map((collection) => {
    const collectionId = text(collection?.id).slice(0, 500)
    const title = text(collection?.name).slice(0, 500)
    if (!collectionId || !title) return null
    const postedSeconds = number(collection?.posted)
    const postedDate = postedSeconds === null ? null : new Date(postedSeconds * 1000)
    const postedAt = postedDate && Number.isFinite(postedDate.getTime()) ? postedDate.toISOString() : null
    const ageDays = postedAt === null ? null : Math.max(0, (now - postedSeconds * 1000) / 86400000)
    const detailsUrl = new URL(`/collection/${encodeURIComponent(collectionId)}`, config.siteUrl).toString()
    return {
      externalId: createHash('sha256').update(`${config.id}\0${collectionId}`).digest('hex'), url: detailsUrl,
      title, channel: config.name, duration: null, thumbnail: null,
      provenance: {
        providerType: 'nzbindex', providerId: config.id, providerName: config.name, resultId: collectionId, collectionId,
        postedTitle: title, postedAt, searchMode: mode, size: number(collection?.size), ageDays, detailsUrl,
        fileCount: number(collection?.fileCount), complete: typeof collection?.complete === 'boolean' ? collection.complete : null,
        poster: text(collection?.poster).slice(0, 240) || null,
        groups: Array.isArray(collection?.groups) ? collection.groups.map((group) => text(group).slice(0, 240)).filter(Boolean).slice(0, 50) : [],
      },
    }
  }).filter(Boolean)
}

export async function searchNzbIndex(config, track, mode, fetchImpl = fetch) {
  const response = await fetchImpl(nzbIndexSearchUrl(config, track, mode), { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 recovery-agent' } })
  if (!response.ok) throw new Error(`NZBIndex returned HTTP ${response.status}.`)
  return parseNzbIndexResults(await response.json(), config, mode)
}

export async function searchUsenetProviders(newznabIndexers, nzbIndex, track, mode, fetchImpl = fetch) {
  const searches = []
  if (newznabIndexers.length) searches.push(searchNewznab(newznabIndexers, track, mode, fetchImpl))
  if (nzbIndex) searches.push(searchNzbIndex(nzbIndex, track, mode, fetchImpl))
  const settled = await Promise.allSettled(searches)
  const batches = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  if (!batches.length && settled.length) throw settled[0].reason
  const results = []
  for (let index = 0; results.length < 40 && batches.some((batch) => index < batch.length); index += 1) {
    for (const batch of batches) if (index < batch.length && results.length < 40) results.push(batch[index])
  }
  return results
}

export function nzbIndexDownloadUrl(config, collectionId) {
  const id = text(collectionId)
  if (!id || id.length > 500 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid NZBIndex collection id.')
  const url = new URL(`/api/download/${encodeURIComponent(id)}.nzb`, config.apiUrl)
  if (text(config.apiKey)) url.searchParams.set('key', text(config.apiKey))
  return url.toString()
}

async function jsonRequest(url, init, label, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
  return body
}

export function downloaderConfig(env = process.env) {
  const sabUrl = text(env.TOMIFY_SABNZBD_URL)
  const nzbgetUrl = text(env.TOMIFY_NZBGET_URL)
  if (sabUrl && nzbgetUrl) throw new Error('Configure either SABnzbd or NZBGet, not both.')
  if (sabUrl) return { type: 'sabnzbd', url: serviceUrl(sabUrl, 'SABnzbd URL'), apiKey: text(env.TOMIFY_SABNZBD_API_KEY), category: text(env.TOMIFY_USENET_CATEGORY) }
  if (nzbgetUrl) return { type: 'nzbget', url: serviceUrl(nzbgetUrl, 'NZBGet URL'), username: text(env.TOMIFY_NZBGET_USERNAME), password: text(env.TOMIFY_NZBGET_PASSWORD), category: text(env.TOMIFY_USENET_CATEGORY) }
  return null
}

function basicAuth(config) { return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` }

export async function submitDownloader(config, nzbUrl, name, fetchImpl = fetch) {
  if (config.type === 'sabnzbd') {
    if (!config.apiKey) throw new Error('SABnzbd API key is not configured.')
    const url = new URL(`${config.url}/api`)
    for (const [key, value] of Object.entries({ output: 'json', apikey: config.apiKey, mode: 'addurl', name: nzbUrl, nzbname: name, cat: config.category })) if (value) url.searchParams.set(key, value)
    const body = await jsonRequest(url, { method: 'GET' }, 'SABnzbd', fetchImpl)
    const remoteId = body?.nzo_ids?.[0]
    if (!remoteId) throw new Error('SABnzbd did not return a queue id.')
    return { downloader: 'sabnzbd', remoteId: String(remoteId) }
  }
  const body = await jsonRequest(`${config.url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basicAuth(config) }, body: JSON.stringify({ method: 'append', params: [`${name}.nzb`, nzbUrl, config.category || '', 0, false, false, '', 0, 'SCORE', true, []] }) }, 'NZBGet', fetchImpl)
  if (!body?.result) throw new Error('NZBGet did not return a queue id.')
  return { downloader: 'nzbget', remoteId: String(body.result) }
}

export async function downloaderStatus(config, remoteId, fetchImpl = fetch) {
  if (config.type === 'sabnzbd') {
    const queue = apiEndpoint(config.url); Object.entries({ output: 'json', apikey: config.apiKey, mode: 'queue', nzo_ids: remoteId }).forEach(([k, v]) => queue.searchParams.set(k, v))
    const queued = await jsonRequest(queue, { method: 'GET' }, 'SABnzbd queue', fetchImpl)
    const slot = queued?.queue?.slots?.find((value) => String(value.nzo_id) === String(remoteId))
    if (slot) return { status: String(slot.status || '').toLowerCase().includes('pause') ? 'queued' : 'downloading', progress: Math.max(0, Math.min(100, number(slot.percentage) || 0)), message: slot.status || null }
    const history = apiEndpoint(config.url); Object.entries({ output: 'json', apikey: config.apiKey, mode: 'history', nzo_ids: remoteId, limit: '20' }).forEach(([k, v]) => history.searchParams.set(k, v))
    const completed = await jsonRequest(history, { method: 'GET' }, 'SABnzbd history', fetchImpl)
    const item = completed?.history?.slots?.find((value) => String(value.nzo_id) === String(remoteId))
    if (!item) return { status: 'queued', progress: 0, message: 'Waiting for downloader' }
    const success = String(item.status).toLowerCase() === 'completed'
    return success ? { status: 'completed', progress: 100, completedPath: text(item.storage) } : { status: 'failed', progress: 0, message: text(item.fail_message || item.status || 'Download failed') }
  }
  const request = async (method, params = []) => jsonRequest(`${config.url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basicAuth(config) }, body: JSON.stringify({ method, params }) }, `NZBGet ${method}`, fetchImpl)
  const groups = (await request('listgroups'))?.result || []
  const group = groups.find((value) => String(value.NZBID) === String(remoteId))
  if (group) { const total = number(group.FileSizeMB) || 0; const remaining = number(group.RemainingSizeMB) || total; return { status: 'downloading', progress: total ? Math.round((total - remaining) / total * 100) : 0, message: group.Status || null } }
  const history = (await request('history', [false]))?.result || []
  const item = history.find((value) => String(value.NZBID) === String(remoteId))
  if (!item) return { status: 'queued', progress: 0, message: 'Waiting for downloader' }
  const success = /SUCCESS|GOOD/i.test(String(item.Status))
  return success ? { status: 'completed', progress: 100, completedPath: text(item.DestDir) } : { status: 'failed', progress: 0, message: text(item.Status || 'Download failed') }
}

export async function validateCompletedPath(value, downloadRoot) {
  if (!downloadRoot) throw new Error('TOMIFY_USENET_DOWNLOAD_DIR is required.')
  const root = await realpath(resolve(downloadRoot))
  const candidate = await realpath(resolve(text(value)))
  if (!inside(candidate, root) || candidate === root) throw new Error('Downloader returned a path outside TOMIFY_USENET_DOWNLOAD_DIR.')
  const details = await stat(candidate)
  if (!details.isDirectory() && !details.isFile()) throw new Error('Downloader completion path is not a regular file or directory.')
  return candidate
}

export async function findCompletedAudio(completedPath, options = {}) {
  const maxBytes = options.maxBytes || 2 * 1024 * 1024 * 1024
  const maxFiles = options.maxFiles || 1000
  const files = []
  let totalBytes = 0
  let fileCount = 0
  let entryCount = 0
  async function visit(path) {
    entryCount += 1
    if (entryCount > maxFiles) throw new Error('Completed Usenet download contains too many filesystem entries.')
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error('Symlinks are not accepted in completed Usenet downloads.')
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) { if (entry === '..' || entry === '.') continue; await visit(join(path, entry)) }
      return
    }
    if (!details.isFile()) return
    fileCount += 1
    totalBytes += details.size
    if (totalBytes > maxBytes) throw new Error('Completed Usenet download exceeds the configured size limit.')
    if (AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) files.push({ path, size: details.size, name: basename(path) })
  }
  await visit(completedPath)
  if (!files.length) throw new Error('Completed Usenet download contains no supported audio files.')
  return { files, totalBytes, fileCount }
}

export function selectCompletedAudio(files, track) {
  const tokens = text(track?.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
  const scored = files.map((file) => ({ file, score: tokens.reduce((sum, token) => sum + (file.name.toLowerCase().includes(token) ? 1 : 0), 0) }))
  scored.sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name))
  return scored[0]?.file || null
}
