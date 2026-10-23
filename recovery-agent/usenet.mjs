import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.mka', '.wma', '.webm'])
const NZBINDEX_API_URL = 'https://api.nzbindex.com'
const NZBINDEX_SITE_URL = 'https://www.nzbindex.com'

function text(value) { return String(value ?? '').trim() }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function isNonInitialMultipart(value) {
  const sequence = text(value).match(/\[(\d{1,5})\s*\/\s*(\d{1,5})\]/)
  return Boolean(sequence && Number(sequence[1]) !== 1)
}
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

const USENET_SEARCH_FIELDS = ['artist', 'album', 'track']
const LEGACY_SEARCH_MODES = { artist: ['artist'], track: ['track'], release: ['album'] }
const FIELD_LABELS = { artist: 'artist', album: 'release/album', track: 'track title' }

function trackFieldValue(track, field) { return text(field === 'artist' ? track?.artist : field === 'album' ? track?.album : track?.title) }

// Accepts a legacy mode string ('artist' | 'track' | 'release'), an array of fields, or an
// existing spec, and returns the fields to combine plus the import mode those fields imply.
// Passing the wanted track lets an artist-only search for music with no track title import the whole download.
export function usenetSearchSpec(input, track) {
  const requested = typeof input === 'string' ? LEGACY_SEARCH_MODES[input] : Array.isArray(input) ? input : Array.isArray(input?.fields) ? input.fields : null
  if (!requested) throw new Error('Choose at least one of artist, album or track to search Usenet.')
  const fields = USENET_SEARCH_FIELDS.filter((field) => requested.includes(field))
  if (!fields.length || fields.length !== new Set(requested).size) throw new Error('Usenet search fields must be artist, album or track.')
  if (['artist', 'track', 'release'].includes(input?.mode) && Array.isArray(input?.fields)) return { fields, mode: input.mode }
  // Naming the album without a track title means the whole release. Artist-only stays a single-track
  // import when there is a track title to match; with none, the chosen download is imported as a release.
  const mode = fields.includes('track') ? 'track' : fields.includes('album') || (track && !trackFieldValue(track, 'track')) ? 'release' : 'artist'
  return { fields, mode }
}

export function usenetSearchQuery(track, input) {
  const { fields } = usenetSearchSpec(input, track)
  const missing = fields.find((field) => !trackFieldValue(track, field))
  if (missing) throw new Error(`A ${FIELD_LABELS[missing]} value is required for this search.`)
  return fields.map((field) => trackFieldValue(track, field)).join(' ').replace(/\s+/g, ' ').slice(0, 240)
}

export function parseNewznabResults(xml, indexer, input) {
  const { fields: searchFields, mode } = usenetSearchSpec(input)
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
      provenance: { providerType: 'newznab', providerId: indexer.id, providerName: indexer.name, resultId: guid, guid, postedTitle: title, searchMode: mode, searchFields, size, ageDays, detailsUrl, categories: xmlAttr(item, 'category') || null },
    }
  }).filter(Boolean)
}

export async function searchNewznab(indexers, track, input, fetchImpl = fetch) {
  const query = usenetSearchQuery(track, input)
  const settled = await Promise.allSettled(indexers.map(async (indexer) => {
    const url = apiEndpoint(indexer.url)
    url.searchParams.set('t', 'search'); url.searchParams.set('q', query); url.searchParams.set('cat', indexer.categories); url.searchParams.set('limit', '40'); url.searchParams.set('o', 'xml'); url.searchParams.set('apikey', indexer.apiKey)
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Tomify/0.1 recovery-agent' } })
    if (!response.ok) throw new Error(`${indexer.name} returned HTTP ${response.status}.`)
    return parseNewznabResults(await response.text(), indexer, usenetSearchSpec(input))
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

export function nzbIndexSearchUrl(config, track, input) {
  const url = new URL('/api/search', config.apiUrl)
  url.searchParams.set('q', usenetSearchQuery(track, input))
  url.searchParams.set('max', '40')
  url.searchParams.set('sort', 'agedesc')
  url.searchParams.set('complete', '1')
  if (text(config.apiKey)) url.searchParams.set('key', text(config.apiKey))
  return url
}

export function parseNzbIndexResults(payload, config, input, now = Date.now()) {
  const { fields: searchFields, mode } = usenetSearchSpec(input)
  if (payload?.error) throw new Error(`NZBIndex search failed${payload.errorMessage ? `: ${text(payload.errorMessage).slice(0, 240)}` : '.'}`)
  const collections = Array.isArray(payload?.data?.content) ? payload.data.content : []
  return collections.filter((collection) => {
    if (collection?.complete === false) return false
    if (mode !== 'release') return true
    return !isNonInitialMultipart(collection?.name)
  }).slice(0, 40).map((collection) => {
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
        postedTitle: title, postedAt, searchMode: mode, searchFields, size: number(collection?.size), ageDays, detailsUrl,
        fileCount: number(collection?.fileCount), complete: typeof collection?.complete === 'boolean' ? collection.complete : null,
        poster: text(collection?.poster).slice(0, 240) || null,
        groups: Array.isArray(collection?.groups) ? collection.groups.map((group) => text(group).slice(0, 240)).filter(Boolean).slice(0, 50) : [],
      },
    }
  }).filter(Boolean)
}

export function assertNzbIndexCandidateComplete(reference) {
  if (reference?.complete === false) throw new Error('The selected NZBIndex collection is incomplete and cannot be acquired.')
  if (reference?.searchMode === 'release' && isNonInitialMultipart(reference?.postedTitle)) throw new Error('The selected NZBIndex result is a numbered multipart fragment, not a complete release.')
}

export async function searchNzbIndex(config, track, input, fetchImpl = fetch) {
  const response = await fetchImpl(nzbIndexSearchUrl(config, track, input), { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 recovery-agent' } })
  if (!response.ok) throw new Error(`NZBIndex returned HTTP ${response.status}.`)
  return parseNzbIndexResults(await response.json(), config, usenetSearchSpec(input))
}

export async function searchUsenetProviders(newznabIndexers, nzbIndex, track, input, fetchImpl = fetch) {
  const spec = usenetSearchSpec(input, track)
  const searches = []
  if (newznabIndexers.length) searches.push(searchNewznab(newznabIndexers, track, spec, fetchImpl))
  if (nzbIndex) searches.push(searchNzbIndex(nzbIndex, track, spec, fetchImpl))
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
  if (sabUrl) return { type: 'sabnzbd', url: serviceUrl(sabUrl, 'SABnzbd URL'), apiKey: text(env.TOMIFY_SABNZBD_API_KEY), category: text(env.TOMIFY_USENET_CATEGORY), downloadRoot: text(env.TOMIFY_SABNZBD_DOWNLOAD_DIR) || null }
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

export async function cancelDownloader(config, remoteId, fetchImpl = fetch) {
  if (config.type === 'sabnzbd') {
    const request = async (mode, parameters = {}) => {
      const url = apiEndpoint(config.url)
      for (const [key, value] of Object.entries({ output: 'json', apikey: config.apiKey, mode, ...parameters })) url.searchParams.set(key, value)
      return jsonRequest(url, { method: 'GET' }, `SABnzbd ${mode}`, fetchImpl)
    }
    const queued = await request('queue', { nzo_ids: remoteId })
    if (queued?.queue?.slots?.some((value) => String(value.nzo_id) === String(remoteId))) {
      const deleted = await request('queue', { name: 'delete', value: remoteId, del_files: '1' })
      return deleted?.status !== false
    }
    const completed = await request('history', { nzo_ids: remoteId, limit: '20' })
    if (!completed?.history?.slots?.some((value) => String(value.nzo_id) === String(remoteId))) return false
    const deleted = await request('history', { name: 'delete', value: remoteId, del_files: '1' })
    return deleted?.status !== false
  }
  const body = await jsonRequest(`${config.url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basicAuth(config) }, body: JSON.stringify({ method: 'editqueue', params: ['GroupFinalDelete', 0, '', [Number(remoteId)]] }) }, 'NZBGet editqueue', fetchImpl)
  return body?.result !== false
}

export async function cancelAgentJob(job, { forget, settled, reload, removeRemote, saveJob, now = () => new Date().toISOString() }) {
  await forget(job.id)
  await settled(job.id)
  job = await reload(job.id)
  const remoteRemoved = await removeRemote(job)
  job.status = 'cancelled'
  job.progress = Number(job.progress) || 0
  job.message = null
  job.error = null
  job.updatedAt = now()
  await saveJob(job)
  const importedPaths = (Array.isArray(job.importResult?.importedTracks) ? job.importResult.importedTracks : []).map((track) => track?.path).filter((path) => typeof path === 'string')
  if (typeof job.importResult?.path === 'string' && job.importResult.path && !importedPaths.includes(job.importResult.path)) importedPaths.push(job.importResult.path)
  return { job, remoteRemoved, importedPaths }
}

function downloaderPresent(job) {
  if (job && Object.hasOwn(job, 'downloaderMissingSince')) delete job.downloaderMissingSince
}

function downloaderMissing(job, { now = Date.now, lostMinutes = Number(process.env.TOMIFY_DOWNLOADER_LOST_MINUTES || 15) } = {}) {
  const timeoutMinutes = Number.isFinite(Number(lostMinutes)) && Number(lostMinutes) > 0 ? Number(lostMinutes) : 15
  const currentTime = typeof now === 'function' ? Number(now()) : Number(now)
  if (!job) return { status: 'queued', progress: 0, message: 'Waiting for downloader' }
  const recordedTime = Date.parse(job.downloaderMissingSince || '')
  const missingSince = Number.isFinite(recordedTime) ? recordedTime : currentTime
  if (!Number.isFinite(recordedTime)) job.downloaderMissingSince = new Date(currentTime).toISOString()
  if (currentTime - missingSince >= timeoutMinutes * 60_000) return { status: 'failed', progress: 0, message: 'downloader-lost: the job is no longer in the downloader' }
  return { status: 'queued', progress: 0, message: 'Waiting for downloader' }
}

export async function downloaderStatus(config, remoteId, fetchImpl = fetch, job = null, options = {}) {
  if (config.type === 'sabnzbd') {
    const queue = apiEndpoint(config.url); Object.entries({ output: 'json', apikey: config.apiKey, mode: 'queue', nzo_ids: remoteId }).forEach(([k, v]) => queue.searchParams.set(k, v))
    const queued = await jsonRequest(queue, { method: 'GET' }, 'SABnzbd queue', fetchImpl)
    const slot = queued?.queue?.slots?.find((value) => String(value.nzo_id) === String(remoteId))
    if (slot) { downloaderPresent(job); return { status: String(slot.status || '').toLowerCase().includes('pause') ? 'queued' : 'downloading', progress: Math.max(0, Math.min(100, number(slot.percentage) || 0)), message: slot.status || null } }
    const history = apiEndpoint(config.url); Object.entries({ output: 'json', apikey: config.apiKey, mode: 'history', nzo_ids: remoteId, limit: '20' }).forEach(([k, v]) => history.searchParams.set(k, v))
    const completed = await jsonRequest(history, { method: 'GET' }, 'SABnzbd history', fetchImpl)
    const item = completed?.history?.slots?.find((value) => String(value.nzo_id) === String(remoteId))
    if (!item) return downloaderMissing(job, options)
    downloaderPresent(job)
    const statusText = text(item.status)
    const normalizedStatus = statusText.toLowerCase().replace(/[^a-z]/g, '')
    // SAB exposes post-processing jobs in history; only its documented terminal states end the job.
    if (normalizedStatus === 'completed') return { status: 'completed', progress: 100, completedPath: text(item.storage) }
    if (normalizedStatus === 'failed') return { status: 'failed', progress: 0, message: text(item.fail_message || statusText || 'Download failed') }
    const activeMessage = statusText || 'Post-processing'
    const activeProgress = Math.max(0, Math.min(100, number(item.percentage) ?? 100))
    return { status: 'downloading', progress: activeProgress, message: activeMessage }
  }
  const request = async (method, params = []) => jsonRequest(`${config.url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basicAuth(config) }, body: JSON.stringify({ method, params }) }, `NZBGet ${method}`, fetchImpl)
  const groups = (await request('listgroups'))?.result || []
  const group = groups.find((value) => String(value.NZBID) === String(remoteId))
  if (group) { downloaderPresent(job); const total = number(group.FileSizeMB) || 0; const remaining = number(group.RemainingSizeMB) || total; return { status: 'downloading', progress: total ? Math.round((total - remaining) / total * 100) : 0, message: group.Status || null } }
  const history = (await request('history', [false]))?.result || []
  const item = history.find((value) => String(value.NZBID) === String(remoteId))
  if (!item) return downloaderMissing(job, options)
  downloaderPresent(job)
  const success = /SUCCESS|GOOD/i.test(String(item.Status))
  return success ? { status: 'completed', progress: 100, completedPath: text(item.DestDir) } : { status: 'failed', progress: 0, message: text(item.Status || 'Download failed') }
}

export async function validateCompletedPath(value, downloadRoot, downloaderRoot = null) {
  if (!downloadRoot) throw new Error('TOMIFY_USENET_DOWNLOAD_DIR is required.')
  const root = await realpath(resolve(downloadRoot))
  let candidatePath = resolve(text(value))
  if (downloaderRoot) {
    const reportedRoot = resolve(text(downloaderRoot))
    if (!inside(candidatePath, reportedRoot)) throw new Error('Downloader returned a path outside TOMIFY_SABNZBD_DOWNLOAD_DIR.')
    candidatePath = resolve(downloadRoot, relative(reportedRoot, candidatePath))
  }
  const candidate = await realpath(candidatePath)
  if (!inside(candidate, root) || candidate === root) throw new Error('Downloader returned a path outside TOMIFY_USENET_DOWNLOAD_DIR.')
  const details = await stat(candidate)
  if (!details.isDirectory() && !details.isFile()) throw new Error('Downloader completion path is not a regular file or directory.')
  return candidate
}

export async function findCompletedAudio(completedPath, options = {}) {
  const maxBytes = options.maxBytes || 2 * 1024 * 1024 * 1024
  const maxFiles = options.maxFiles || 1000
  const label = options.label || 'Usenet download'
  const files = []
  let totalBytes = 0
  let fileCount = 0
  let entryCount = 0
  async function visit(path) {
    entryCount += 1
    if (entryCount > maxFiles) throw new Error(`Completed ${label} contains too many filesystem entries.`)
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error(`Symlinks are not accepted in a completed ${label}.`)
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) { if (entry === '..' || entry === '.') continue; await visit(join(path, entry)) }
      return
    }
    if (!details.isFile()) return
    fileCount += 1
    totalBytes += details.size
    if (totalBytes > maxBytes) throw new Error(`Completed ${label} exceeds the configured size limit.`)
    if (AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) files.push({ path, size: details.size, name: basename(path) })
  }
  await visit(completedPath)
  if (!files.length && !options.allowEmpty) throw new Error(`Completed ${label} contains no supported audio files.`)
  return { files, totalBytes, fileCount }
}

export function selectCompletedAudio(files, track) {
  const tokens = text(track?.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
  const scored = files.map((file) => ({ file, score: tokens.reduce((sum, token) => sum + (file.name.toLowerCase().includes(token) ? 1 : 0), 0) }))
  scored.sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name))
  return scored[0]?.file || null
}

// ---------------------------------------------------------------------------------------------------------------
// Tomifin Downloader (films and TV): Newznab search by category and a SABnzbd client that uploads NZB files the agent
// has fetched and checked itself. Recovery's music search and addurl submission above are unchanged.

// Searches every configured Newznab indexer for films and TV (Newznab categories 2000 Movies, 5000 TV). One failing
// indexer does not hide the others; the search fails only when all of them do. Error messages never carry a URL or
// an API key.
export async function searchNewznabVideo(indexers, query, categories, { fetchImpl = fetch, timeoutMs = 25_000, now = Date.now } = {}) {
  const settled = await Promise.allSettled(indexers.map(async (indexer) => {
    const url = apiEndpoint(indexer.url)
    url.searchParams.set('t', 'search'); url.searchParams.set('q', text(query).slice(0, 200)); url.searchParams.set('cat', categories); url.searchParams.set('limit', '100'); url.searchParams.set('o', 'xml'); url.searchParams.set('apikey', indexer.apiKey)
    let response
    try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Tomify/0.1 recovery-agent' } }) }
    catch { throw new Error(`${indexer.name} could not be reached.`) }
    if (!response.ok) throw new Error(`${indexer.name} returned HTTP ${response.status}.`)
    const body = await response.text()
    if (/<error\b/i.test(body.slice(0, 2000))) throw new Error(`${indexer.name} refused the search.`)
    return parseNewznabVideoResults(body, indexer, now())
  }))
  if (settled.length && settled.every((result) => result.status === 'rejected')) throw settled[0].reason
  const failedNames = indexers.filter((_indexer, index) => settled[index].status === 'rejected').map((indexer) => indexer.name)
  return { results: settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []), failed: failedNames.length, failedNames }
}

// NZBIndex for Tomifin: a free-text search of complete collections (NZBIndex has no categories), anonymous unless
// TOMIFY_NZBINDEX_API_KEY is set. Results carry the collection id for the agent only; no URL is built here.
export async function searchNzbIndexVideo(config, query, { fetchImpl = fetch, timeoutMs = 25_000, now = Date.now } = {}) {
  const url = new URL('/api/search', config.apiUrl)
  url.searchParams.set('q', text(query).slice(0, 200)); url.searchParams.set('max', '100'); url.searchParams.set('sort', 'agedesc'); url.searchParams.set('complete', '1')
  if (text(config.apiKey)) url.searchParams.set('key', text(config.apiKey))
  let response
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 recovery-agent' } }) }
  catch { throw new Error(`${config.name} could not be reached.`) }
  if (!response.ok) throw new Error(`${config.name} returned HTTP ${response.status}.`)
  let payload
  try { payload = await response.json() } catch { throw new Error(`${config.name} sent an answer that could not be read.`) }
  return parseNzbIndexVideoResults(payload, config, now())
}

export function parseNzbIndexVideoResults(payload, config, now = Date.now()) {
  if (payload?.error) throw new Error(`${config.name} refused the search.`)
  const collections = Array.isArray(payload?.data?.content) ? payload.data.content : []
  return collections.filter((collection) => collection?.complete !== false && !isNonInitialMultipart(collection?.name)).slice(0, 100).map((collection) => {
    const collectionId = text(collection?.id)
    const title = text(collection?.name).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 500)
    if (!title || !collectionId || collectionId.length > 500 || !/^[a-zA-Z0-9_-]+$/.test(collectionId)) return null
    const size = number(collection?.size)
    const posted = number(collection?.posted)
    return {
      provider: 'nzbindex', indexerId: config.id, indexerName: config.name, collectionId, title,
      size: size !== null && size > 0 ? size : null,
      ageDays: posted !== null && posted > 0 ? Math.max(0, Math.floor((now - posted * 1000) / 86_400_000)) : null,
      grabs: null, comments: null,
    }
  }).filter(Boolean)
}

export function parseNewznabVideoResults(xml, indexer, now = Date.now()) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || []
  return items.slice(0, 100).map((item) => {
    const title = text(xmlTag(item, 'title')).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 500)
    const rawGuid = xmlTag(item, 'guid') || xmlTag(item, 'link')
    let guid = rawGuid
    try { const parsed = new URL(rawGuid); guid = parsed.searchParams.get('id') || basename(parsed.pathname) } catch { /* An opaque GUID. */ }
    guid = text(guid).slice(0, 200)
    if (!title || !guid || !/^[A-Za-z0-9._~-]+$/.test(guid)) return null
    const size = number(xmlAttr(item, 'size') || xmlTag(item, 'size') || item.match(/<enclosure\s[^>]*length=["'](\d+)/i)?.[1])
    const posted = Date.parse(xmlAttr(item, 'usenetdate') || xmlTag(item, 'pubDate'))
    const grabs = number(xmlAttr(item, 'grabs'))
    return {
      provider: 'newznab', indexerId: indexer.id, indexerName: indexer.name, guid, title,
      size: size !== null && size > 0 ? size : null,
      ageDays: Number.isFinite(posted) ? Math.max(0, Math.floor((now - posted) / 86_400_000)) : null,
      grabs: grabs !== null && grabs >= 0 ? Math.round(grabs) : null,
      comments: xmlTag(item, 'comments') || null,
    }
  }).filter(Boolean)
}

// Errors from SABnzbd say whether it certainly did not act (rejected: it answered with a refusal) or whether the
// outcome is unknown (uncertain: no answer, or one that could not be read).
function sabError(message, kind) { return Object.assign(new Error(message), { [kind]: true }) }
function sabMessage(value) { return text(value).replace(/https?:\/\/\S+/g, '[link]').replace(/\/[^\s'"]+/g, '[path]').slice(0, 200) }

export function createSabnzbdClient(config, fetchImpl = fetch) {
  async function api(mode, parameters = {}, { body = null, timeoutMs = 30_000 } = {}) {
    if (!config?.apiKey) throw sabError('SABnzbd API key is not configured.', 'rejected')
    const url = apiEndpoint(config.url)
    for (const [key, value] of Object.entries({ output: 'json', apikey: config.apiKey, mode, ...parameters })) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    let response
    try { response = await fetchImpl(url, { method: body ? 'POST' : 'GET', body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }) }
    catch { throw sabError('SABnzbd could not be reached.', 'uncertain') }
    // A 5xx (or a proxy in front answering for SABnzbd) says nothing certain about whether the request was acted on.
    if (!response.ok) throw sabError(`SABnzbd returned HTTP ${response.status}.`, response.status >= 500 ? 'uncertain' : 'rejected')
    let payload
    try { payload = await response.json() } catch { throw sabError('SABnzbd sent an answer that could not be read.', 'uncertain') }
    if (payload?.status === false) throw sabError(`SABnzbd refused it${payload.error ? `: ${sabMessage(payload.error)}` : '.'}`, 'rejected')
    return payload
  }
  return {
    async version() { return text((await api('version'))?.version) || null },
    async categories() {
      const values = (await api('get_cats'))?.categories
      return Array.isArray(values) ? values.map(text) : []
    },
    // Uploads an NZB the agent has already fetched and checked. name becomes SABnzbd's job name (and folder name), so
    // Tomifin can find the job again by name even if this answer is lost.
    async addFile(nzb, { name, category }) {
      const form = new FormData()
      form.set('name', new Blob([nzb], { type: 'application/x-nzb' }), `${name}.nzb`)
      const payload = await api('addfile', { nzbname: name, cat: category, priority: '-100' }, { body: form, timeoutMs: 60_000 })
      const id = Array.isArray(payload?.nzo_ids) ? text(payload.nzo_ids[0]) : ''
      if (!id) throw sabError('SABnzbd did not accept the NZB.', 'rejected')
      return { nzoId: id }
    },
    async queue() {
      const queue = (await api('queue', { limit: '500' }))?.queue || {}
      return { slots: Array.isArray(queue.slots) ? queue.slots : [], kbPerSec: number(queue.kbpersec), paused: queue.paused === true }
    },
    async history(category) {
      const history = (await api('history', { limit: '500', category }))?.history || {}
      return Array.isArray(history.slots) ? history.slots : []
    },
    async pause(id) { await api('queue', { name: 'pause', value: id }) },
    async resume(id) { await api('queue', { name: 'resume', value: id }) },
    async deleteQueued(id, deleteFiles) { await api('queue', { name: 'delete', value: id, del_files: deleteFiles ? '1' : '0' }) },
    async deleteHistory(id, deleteFiles) { await api('history', { name: 'delete', value: id, del_files: deleteFiles ? '1' : '0' }) },
  }
}
