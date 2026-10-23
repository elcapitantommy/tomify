import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { isIP } from 'node:net'
import { configuredTorrentIndexers, fetchIndexerTorrent, isIndexerLink, searchTorrentIndexers } from './torrent-indexers.mjs'
import { usenetSearchSpec } from './usenet.mjs'

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z'])
// qBittorrent states for a torrent whose data is fully downloaded (4.x names, plus the 5.x "stopped" rename).
const COMPLETE_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP'])
const PAUSED_STATES = new Set(['pausedDL', 'stoppedDL'])
const FAILED_STATES = new Set(['error', 'missingFiles'])
// A freshly added magnet can take a moment to appear in qBittorrent's list.
const MISSING_GRACE_MS = 2 * 60_000
const SEARCH_RESULT_LIMIT = 12
const SEARCH_TIMEOUT_MS = 25_000

function text(value) { return String(value ?? '').trim() }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function serviceUrl(value, label) {
  const url = new URL(text(value))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error(`${label} must use HTTPS (or loopback HTTP).`)
  return url.toString().replace(/\/$/, '')
}

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

function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const version = isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (version === 6) return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:')
  return false
}

// Accepts a magnet link or an http(s) link to a .torrent file. The full link is what qBittorrent is given;
// displayUrl drops trackers and query strings, which can carry private-tracker passkeys. Download links from a
// configured Prowlarr or Jackett are allowed on a private address; the agent fetches those itself.
export function parseTorrentLink(value, { indexers = configuredTorrentIndexers() } = {}) {
  const link = text(value)
  if (!link) throw new Error('Paste a magnet link or a link to a .torrent file.')
  if (link.length > 8000) throw new Error('The torrent link is too long.')
  if (/^magnet:\?/i.test(link)) {
    const params = new URLSearchParams(link.slice(link.indexOf('?') + 1))
    const topic = params.getAll('xt').map((entry) => entry.match(/^urn:btih:([a-z0-9]+)$/i)?.[1]).find(Boolean)
    if (!topic) throw new Error('The magnet link has no BitTorrent info hash (xt=urn:btih:…).')
    const infoHash = /^[a-f0-9]{40}$/i.test(topic) ? topic.toLowerCase() : /^[a-z2-7]{32}$/i.test(topic) ? base32ToHex(topic) : null
    if (!infoHash) throw new Error('The magnet link has an invalid info hash.')
    const name = text(params.get('dn')).slice(0, 500) || null
    const displayUrl = `magnet:?xt=urn:btih:${infoHash}${name ? `&dn=${encodeURIComponent(name)}` : ''}`
    return { type: 'magnet', link, infoHash, name, displayUrl }
  }
  let url
  try { url = new URL(link) } catch { throw new Error('Paste a magnet link or a link to a .torrent file.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Torrent links must be magnet links or http(s) links to a .torrent file.')
  if (url.username || url.password) throw new Error('Torrent links must not contain a username or password.')
  if (privateHost(url.hostname) && !isIndexerLink(url.toString(), indexers)) throw new Error('Torrent file links must point to a public host.')
  let name = null
  try { name = decodeURIComponent(basename(url.pathname)).replace(/\.torrent$/i, '').trim().slice(0, 500) || null } catch { name = null }
  return { type: 'url', link: url.toString(), infoHash: null, name, displayUrl: `${url.origin}${url.pathname}` }
}

// A wanted item without a track title is an album (or "anything by this artist"), so the whole download is imported.
export function torrentSearchMode(track) {
  return text(track?.title) ? 'track' : 'release'
}

export function torrentCandidate(value, track, options) {
  const parsed = parseTorrentLink(value, options)
  const resultId = parsed.infoHash || createHash('sha256').update(parsed.link).digest('hex')
  const searchMode = torrentSearchMode(track)
  return {
    externalId: createHash('sha256').update(`torrent\0${resultId}`).digest('hex'), url: parsed.displayUrl,
    title: parsed.name || (parsed.infoHash ? `Torrent ${parsed.infoHash.slice(0, 12)}` : 'Torrent file link'), channel: 'Torrent link', duration: null, thumbnail: null,
    provenance: { providerType: 'torrent', providerId: 'torrent-link', providerName: 'Torrent link', resultId, linkType: parsed.type, infoHash: parsed.infoHash, link: parsed.link, displayUrl: parsed.displayUrl, postedTitle: parsed.name, searchMode, searchFields: null },
  }
}

// Query parameters that carry credentials on torrent sites and indexers (API keys, passkeys, session ids, …).
const SECRET_PARAMETER = /(api|pass|auth|token|secret|key|sig|sess|sid|cookie|login|user|uid|rss|hash|code|jwt|nonce)/i
// A value that looks like a generated secret: long hex, or a long run of mixed letters and digits with no separators.
function secretLooking(value) {
  const raw = text(value)
  return /^[a-f0-9]{32,}$/i.test(raw) || (/^[A-Za-z0-9+/=_-]{24,}$/.test(raw) && /[0-9]/.test(raw) && /[A-Za-z]/.test(raw) && !/[-_]/.test(raw))
}

// A result's details page, for showing as a link. Results come from third-party plugins and indexers, so the link is
// cleaned before anyone sees it: only public http(s) pages, no user name or password, no fragment, no query parameter
// that could carry a credential, and nothing at all when a path segment looks like a passkey.
export function safeDetailsUrl(value) {
  let url
  try { url = new URL(text(value)) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || privateHost(url.hostname)) return null
  let segments
  try { segments = url.pathname.split('/').map((segment) => decodeURIComponent(segment)) } catch { return null }
  if (segments.some(secretLooking)) return null
  url.hash = ''
  for (const [name, parameter] of [...url.searchParams]) if (SECRET_PARAMETER.test(name) || secretLooking(parameter)) url.searchParams.delete(name)
  if (![...url.searchParams].length) url.search = ''
  return url.toString()
}

function siteName(value) {
  try { return new URL(text(value)).hostname.replace(/^www\./, '') || null } catch { return null }
}

// Normalises qBittorrent search-plugin and indexer results: only results with at least one seed are kept (sources
// report -1 when they do not know), the best-seeded come first, the same torrent found by several sources appears
// once, and links qBittorrent could not be given safely (private hosts other than a configured indexer, credentials,
// plugin-only URLs) are dropped. Recovery and Tomifin Downloader both build on this.
export function seededTorrentResults(results, options) {
  const seen = new Set()
  const found = []
  // Best-seeded first, so where several sources found the same torrent the copy with the most seeds is kept.
  const ranked = (Array.isArray(results) ? results : []).map((result) => ({ result, seeds: number(result?.nbSeeders) ?? -1 })).sort((a, b) => b.seeds - a.seeds).map(({ result }) => result)
  for (const result of ranked) {
    const seeds = number(result?.nbSeeders)
    if (seeds === null || seeds < 1) continue
    let parsed
    try { parsed = parseTorrentLink(result?.fileUrl, options) } catch { continue }
    const resultId = parsed.infoHash || createHash('sha256').update(parsed.link).digest('hex')
    const key = parsed.infoHash || text(result?.infoHash).toLowerCase() || resultId
    if (seen.has(key)) continue
    seen.add(key)
    const detailsUrl = safeDetailsUrl(result?.descrLink)
    const leechers = number(result?.nbLeechers)
    const size = number(result?.fileSize)
    const site = text(result?.siteName).slice(0, 120) || siteName(result?.siteUrl) || siteName(detailsUrl) || 'Torrent search'
    const title = text(result?.fileName).slice(0, 500) || parsed.name || `Torrent ${resultId.slice(0, 12)}`
    found.push({ parsed, resultId, seeds, leechers: leechers !== null && leechers >= 0 ? leechers : null, size: size !== null && size > 0 ? size : null, site, title, detailsUrl, searchSource: text(result?.indexerId) || 'qbittorrent-plugins' })
  }
  return found
}

// Turns qBittorrent search-plugin and indexer results into Recovery candidates (see seededTorrentResults).
export function torrentSearchCandidates(results, track, input, options) {
  const { fields: searchFields, mode: searchMode } = usenetSearchSpec(input, track)
  return seededTorrentResults(results, options).slice(0, SEARCH_RESULT_LIMIT).map(({ parsed, resultId, seeds, leechers, size, site, title, detailsUrl, searchSource }) => ({
    externalId: createHash('sha256').update(`torrent\0${resultId}`).digest('hex'), url: detailsUrl || parsed.displayUrl,
    title, channel: site, duration: null, thumbnail: null,
    // providerId stays qbittorrent-search for every search result: the agent labels the job from it.
    provenance: { providerType: 'torrent', providerId: 'qbittorrent-search', providerName: site, searchSource, resultId, linkType: parsed.type, infoHash: parsed.infoHash, link: parsed.link, displayUrl: parsed.displayUrl, detailsUrl, postedTitle: title, searchMode, searchFields, seeds, peers: leechers, size },
  }))
}

export function torrentConfig(env = process.env) {
  const url = text(env.TOMIFY_QBITTORRENT_URL)
  if (!url) return null
  const configuredMax = Number(env.TOMIFY_TORRENT_MAX_BYTES || 4 * 1024 * 1024 * 1024)
  return {
    type: 'qbittorrent', url: serviceUrl(url, 'qBittorrent URL'), username: text(env.TOMIFY_QBITTORRENT_USERNAME), password: text(env.TOMIFY_QBITTORRENT_PASSWORD),
    category: text(env.TOMIFY_TORRENT_CATEGORY) || 'tomify', downloadRoot: text(env.TOMIFY_QBITTORRENT_DOWNLOAD_DIR) || null,
    maxBytes: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 4 * 1024 * 1024 * 1024,
    maxActiveDownloads: torrentMaxActive(env.TOMIFY_TORRENT_MAX_ACTIVE),
    maxFiles: torrentMaxFiles(env.TOMIFY_TORRENT_MAX_FILES),
    indexers: configuredTorrentIndexers(env),
  }
}

// How many files and folders a completed torrent may hold. Discographies of 100 CDs run to a few thousand.
export const DEFAULT_TORRENT_MAX_FILES = 10000
function torrentMaxFiles(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 100000 ? parsed : DEFAULT_TORRENT_MAX_FILES
}

// How many torrents qBittorrent downloads at once. qBittorrent's own queue limits decide this, so the agent sets them.
export const DEFAULT_TORRENT_MAX_ACTIVE = 5
function torrentMaxActive(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : DEFAULT_TORRENT_MAX_ACTIVE
}

// qBittorrent queue settings for a download limit. Finished torrents waiting to be imported still take an active
// torrent slot, so the overall limit leaves room for them on top of the downloads.
export function qbittorrentQueuePreferences(maxActiveDownloads = DEFAULT_TORRENT_MAX_ACTIVE) {
  const downloads = torrentMaxActive(maxActiveDownloads)
  return { queueing_enabled: true, max_active_downloads: downloads, max_active_uploads: downloads, max_active_torrents: downloads * 2 }
}

export function torrentCapability({ config = null, downloadRoot = null } = {}) {
  return { available: Boolean(config && downloadRoot) }
}

// Live transfer figures for the Recovery page. qBittorrent reports an unknown ETA as 8640000 (100 days).
export function torrentTransferDetails(torrent) {
  const eta = number(torrent?.eta)
  const nonNegative = (value) => { const parsed = number(value); return parsed !== null && parsed >= 0 ? Math.round(parsed) : null }
  return {
    downloadSpeed: nonNegative(torrent?.dlspeed), uploadSpeed: nonNegative(torrent?.upspeed),
    seeds: nonNegative(torrent?.num_seeds), seedsInSwarm: nonNegative(torrent?.num_complete),
    peers: nonNegative(torrent?.num_leechs), peersInSwarm: nonNegative(torrent?.num_incomplete),
    eta: eta !== null && eta >= 0 && eta < 8640000 ? Math.round(eta) : null,
    size: nonNegative(torrent?.total_size) || nonNegative(torrent?.size), downloaded: nonNegative(torrent?.downloaded),
  }
}

// Maps one qBittorrent torrents/info entry to the job states the Usenet poller already understands.
export function qbittorrentJobState(torrent, options = {}) {
  const state = qbittorrentBaseState(torrent, options)
  return torrent ? { ...state, details: torrentTransferDetails(torrent) } : state
}

function qbittorrentBaseState(torrent, { createdAt, maxBytes, now = Date.now() } = {}) {
  if (!torrent) {
    const age = now - Date.parse(createdAt || '')
    if (Number.isFinite(age) && age < MISSING_GRACE_MS) return { status: 'queued', progress: 0, message: 'Waiting for qBittorrent' }
    return { status: 'failed', progress: 0, message: 'The torrent is no longer in qBittorrent.' }
  }
  const state = text(torrent.state)
  const progress = Math.max(0, Math.min(100, Math.floor((number(torrent.progress) || 0) * 100)))
  const size = number(torrent.total_size) || number(torrent.size) || 0
  if (maxBytes && size > maxBytes) return { status: 'failed', progress, message: 'The torrent is larger than TOMIFY_TORRENT_MAX_BYTES.', remove: true }
  if (FAILED_STATES.has(state)) return { status: 'failed', progress, message: state === 'missingFiles' ? 'qBittorrent reports the torrent files are missing.' : 'qBittorrent reported an error for this torrent.' }
  if (COMPLETE_STATES.has(state) && number(torrent.progress) >= 1) return { status: 'completed', progress: 100, completedPath: text(torrent.content_path) }
  if (state === 'metaDL') return { status: 'downloading', progress: 0, message: 'Fetching torrent metadata' }
  if (PAUSED_STATES.has(state)) return { status: 'queued', progress, message: 'Paused in qBittorrent' }
  if (state === 'queuedDL') return { status: 'queued', progress, message: 'Queued in qBittorrent' }
  if (state === 'stalledDL') return { status: 'downloading', progress, message: 'Waiting for peers' }
  if (state.startsWith('checking')) return { status: 'downloading', progress, message: 'Checking files' }
  if (state === 'moving') return { status: 'downloading', progress, message: 'Moving files' }
  return { status: 'downloading', progress, message: null }
}

export function createQbittorrentClient(config, fetchImpl = fetch) {
  async function session() {
    if (!config.username) return null
    const response = await fetchImpl(`${config.url}/api/v2/auth/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: config.username, password: config.password }), signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    if (response.status === 403) throw new Error('qBittorrent has temporarily banned this client after failed logins.')
    if (!response.ok || text(body) !== 'Ok.') throw new Error('qBittorrent rejected the configured username or password.')
    const cookie = (response.headers.get('set-cookie') || '').match(/(?:^|[;,]\s*)(SID|QBT_SID_\d+)=([^;]+)/)
    if (!cookie) throw new Error('qBittorrent did not return a session cookie.')
    return `${cookie[1]}=${cookie[2]}`
  }

  async function call(cookie, path, form, label) {
    const response = await fetchImpl(`${config.url}/api/v2/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    return { response, body, label }
  }

  async function ensureCategory(cookie, category, savePath) {
    const { response } = await call(cookie, 'torrents/createCategory', { category, savePath }, 'qBittorrent category')
    // 409 means the category already exists, which is fine.
    if (!response.ok && response.status !== 409) throw new Error(`qBittorrent category returned HTTP ${response.status}.`)
  }

  async function upload(cookie, torrent, form) {
    const data = new FormData()
    for (const [key, value] of Object.entries(form)) if (key !== 'urls') data.set(key, value)
    data.set('torrents', new Blob([torrent], { type: 'application/x-bittorrent' }), 'tomify.torrent')
    const response = await fetchImpl(`${config.url}/api/v2/torrents/add`, { method: 'POST', headers: cookie ? { cookie } : {}, body: data, signal: AbortSignal.timeout(30_000) })
    return { response, body: await response.text() }
  }

  async function renamedCall(hash, current, legacy, label) {
    const cookie = await session()
    let { response } = await call(cookie, current, { hashes: hash }, label)
    if (response.status === 404) ({ response } = await call(cookie, legacy, { hashes: hash }, label))
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
  }

  let queueApplied = false
  // Sets qBittorrent's queue limits once per agent run. A failure is not fatal: the torrent is still added or polled
  // and the next call tries again.
  async function ensureQueueLimits(cookie) {
    if (queueApplied) return
    const preferences = qbittorrentQueuePreferences(config.maxActiveDownloads)
    const { response } = await call(cookie, 'app/setPreferences', { json: JSON.stringify(preferences) }, 'qBittorrent preferences').catch(() => ({ response: { ok: false } }))
    if (response.ok) queueApplied = true
  }

  return {
    // category defaults to Recovery's; Tomifin Downloader passes its own per destination. subfolder keeps a
    // multi-file torrent in a folder of its own rather than spread over the save path. downloadPath (qBittorrent 4.4
    // and later) keeps unfinished data there and moves it to savePath when the torrent completes.
    async add(link, { tag, savePath, downloadPath = null, category = config.category, subfolder = false }) {
      // An error marked rejected means qBittorrent certainly did not add the torrent: it was never sent, or
      // qBittorrent answered with a refusal. Any other error (a timeout, a dropped connection) leaves it unknown.
      const rejected = (error) => Object.assign(error instanceof Error ? error : new Error(String(error)), { rejected: true })
      let cookie, fetched
      try {
        // An indexer link is fetched here first: it needs the indexer's API key, and qBittorrent may not reach it.
        fetched = isIndexerLink(link, config.indexers || []) ? await fetchIndexerTorrent(link, config.indexers, fetchImpl) : null
        cookie = await session()
        await ensureCategory(cookie, category, savePath)
        await ensureQueueLimits(cookie)
      } catch (error) { throw rejected(error) }
      // contentLayout is qBittorrent 4.3.2 and later; root_folder is the older name for the same choice.
      const form = { urls: fetched?.magnet || link, category, tags: tag, savepath: savePath, ...(downloadPath ? { useDownloadPath: 'true', downloadPath } : {}), ...(subfolder ? { contentLayout: 'Subfolder', root_folder: 'true' } : {}) }
      const { response, body } = fetched?.torrent ? await upload(cookie, fetched.torrent, form) : await call(cookie, 'torrents/add', form, 'qBittorrent add')
      if (!response.ok) throw rejected(new Error(`qBittorrent add returned HTTP ${response.status}.`))
      if (/^fails/i.test(text(body))) throw rejected(new Error('qBittorrent refused the torrent link (it may already be in qBittorrent).'))
      return { downloader: 'qbittorrent', remoteId: tag }
    },
    async findByHash(hash) {
      const cookie = await session()
      const url = new URL(`${config.url}/api/v2/torrents/info`)
      url.searchParams.set('hashes', hash)
      const response = await fetchImpl(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
      const torrents = await response.json()
      return (Array.isArray(torrents) ? torrents : []).find((torrent) => text(torrent?.hash).toLowerCase() === hash.toLowerCase()) || null
    },
    // Hands a torrent qBittorrent already has to a new job: adds the job's tag and drops the old jobs' tags.
    async retag(hash, { tag, previousTags = [] }) {
      const cookie = await session()
      const added = await call(cookie, 'torrents/addTags', { hashes: hash, tags: tag }, 'qBittorrent tag')
      if (!added.response.ok) throw new Error(`qBittorrent tag returned HTTP ${added.response.status}.`)
      if (previousTags.length) {
        const removed = await call(cookie, 'torrents/removeTags', { hashes: hash, tags: previousTags.join(',') }, 'qBittorrent untag')
        if (!removed.response.ok) throw new Error(`qBittorrent untag returned HTTP ${removed.response.status}.`)
      }
      return { downloader: 'qbittorrent', remoteId: tag }
    },
    async info(tag) {
      const cookie = await session()
      // Also applied while polling, so torrents already queued pick up the limits after an agent update.
      await ensureQueueLimits(cookie)
      const url = new URL(`${config.url}/api/v2/torrents/info`)
      url.searchParams.set('tag', tag)
      const response = await fetchImpl(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
      const torrents = await response.json()
      // Older qBittorrent releases ignore the tag filter, so match the tag here too.
      return (Array.isArray(torrents) ? torrents : []).find((torrent) => text(torrent?.tags).split(',').map(text).includes(tag)) || null
    },
    // Searches qBittorrent's enabled search plugins (Music category) and any configured Prowlarr or Torznab indexers
    // at once, and returns the raw results in the plugins' shape. Plugins run inside qBittorrent on the media server;
    // the search is refused while qBittorrent reports it is offline, which is what it reports when the VPN interface
    // it is bound to is down, since nothing found could be downloaded.
    // category is the search-plugin category and indexerCategories the Torznab categories (default: each indexer's
    // own, normally 3000 Audio); Tomifin Downloader asks for films and TV instead.
    async search(pattern, { category = 'music', indexerCategories = null, timeoutMs = SEARCH_TIMEOUT_MS, pollMs = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
      const cookie = await session()
      const get = async (path, params = {}) => {
        const url = new URL(`${config.url}/api/v2/${path}`)
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
        const response = await fetchImpl(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`qBittorrent ${path} returned HTTP ${response.status}.`)
        return response.json()
      }
      const transfer = await get('transfer/info')
      if (text(transfer?.connection_status) === 'disconnected') throw new Error('qBittorrent is offline, so torrent search is paused. Check that NordVPN is connected on the media server.')
      const plugins = await get('search/plugins')
      const indexers = (config.indexers || []).map((indexer) => indexerCategories ? { ...indexer, categories: indexerCategories } : indexer)
      const usePlugins = (Array.isArray(plugins) ? plugins : []).some((plugin) => plugin?.enabled)
      if (!usePlugins && !indexers.length) throw new Error('No torrent search source is set up: qBittorrent has no search plugins enabled and no Prowlarr or Jackett indexer is configured. See docs/RECOVERY.md.')
      const pluginSearch = async () => {
        const started = await call(cookie, 'search/start', { pattern, plugins: 'enabled', category }, 'qBittorrent search')
        if (started.response.status === 409) throw new Error('qBittorrent is already running too many searches. Try again in a moment.')
        if (!started.response.ok) throw new Error(`qBittorrent search returned HTTP ${started.response.status}.`)
        const id = number(JSON.parse(started.body || '{}')?.id)
        if (id === null) throw new Error('qBittorrent did not return a search id.')
        try {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const status = await get('search/status', { id })
            if (text((Array.isArray(status) ? status[0] : status)?.status) === 'Stopped') break
            await sleep(pollMs)
          }
          const found = await get('search/results', { id, limit: 500 })
          return Array.isArray(found?.results) ? found.results : []
        } finally {
          await call(cookie, 'search/stop', { id }, 'qBittorrent search stop').catch(() => {})
          await call(cookie, 'search/delete', { id }, 'qBittorrent search delete').catch(() => {})
        }
      }
      const searches = [...(usePlugins ? [pluginSearch()] : []), ...(indexers.length ? [searchTorrentIndexers(indexers, pattern, { fetchImpl })] : [])]
      const settled = await Promise.allSettled(searches)
      if (settled.every((result) => result.status === 'rejected')) throw settled[0].reason
      return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    },
    // qBittorrent's own view of its network: connected, firewalled or disconnected. qBittorrent is bound to the VPN
    // interface, so "disconnected" is what it reports while the VPN is down.
    async connection() {
      const cookie = await session()
      const response = await fetchImpl(`${config.url}/api/v2/transfer/info`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
      const status = text((await response.json())?.connection_status).toLowerCase()
      return ['connected', 'firewalled', 'disconnected'].includes(status) ? status : 'unknown'
    },
    // Every torrent in one category, with one login (Tomifin's downloads list).
    async list(category) {
      const cookie = await session()
      const url = new URL(`${config.url}/api/v2/torrents/info`)
      url.searchParams.set('category', category)
      const response = await fetchImpl(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
      const torrents = await response.json()
      return (Array.isArray(torrents) ? torrents : []).filter((torrent) => text(torrent?.category) === category)
    },
    // qBittorrent 5 renamed pause and resume to stop and start; the old names answer 404 there, and the new ones on 4.x.
    async pause(hash) { await renamedCall(hash, 'torrents/stop', 'torrents/pause', 'qBittorrent pause') },
    async resume(hash) { await renamedCall(hash, 'torrents/start', 'torrents/resume', 'qBittorrent resume') },
    async remove(hash, deleteFiles) {
      const cookie = await session()
      const { response } = await call(cookie, 'torrents/delete', { hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' }, 'qBittorrent delete')
      if (!response.ok) throw new Error(`qBittorrent delete returned HTTP ${response.status}.`)
    },
  }
}

// First volumes only: 7-Zip reads the remaining parts of a multi-volume archive itself.
export function isExtractableArchive(name) {
  const lower = name.toLowerCase()
  if (/\.(7z|zip)\.\d{3}$/.test(lower)) return /\.001$/.test(lower)
  if (!ARCHIVE_EXTENSIONS.has(extname(lower))) return false
  const part = lower.match(/\.part(\d+)\.rar$/)
  return !part || Number(part[1]) === 1
}

export async function findArchives(root, maxEntries = 1000) {
  const archives = []
  let entries = 0
  async function visit(path) {
    entries += 1
    if (entries > maxEntries) throw new Error('Completed torrent contains too many filesystem entries.')
    const details = await lstat(path)
    if (details.isSymbolicLink()) return
    if (details.isDirectory()) { for (const entry of await readdir(path)) await visit(join(path, entry)); return }
    if (details.isFile() && isExtractableArchive(basename(path))) archives.push(path)
  }
  await visit(root)
  return archives.sort()
}

// Parses `7z l -slt -ba` output and refuses archives that would write outside the extraction folder.
export function checkArchiveListing(listing, maxBytes) {
  let total = 0
  const paths = []
  for (const block of String(listing || '').split(/\r?\n\r?\n/)) {
    const path = block.match(/^Path = (.*)$/m)?.[1]
    if (path === undefined) continue
    const parts = path.split(/[\\/]/)
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || parts.includes('..')) throw new Error('An archive in the torrent contains an unsafe path.')
    if (/^Attributes = .*\sl[rwx-]{9}/m.test(block) || /^Symbolic Link = ./m.test(block)) throw new Error('An archive in the torrent contains a symbolic link.')
    total += number(block.match(/^Size = (\d+)$/m)?.[1]) || 0
    paths.push(path)
  }
  if (total > maxBytes) throw new Error('An archive in the torrent would extract beyond TOMIFY_TORRENT_MAX_BYTES.')
  return { paths, totalBytes: total }
}

// Extracts each archive into its own numbered folder under destination. The torrent's own files are left
// untouched so qBittorrent can keep seeding them.
export async function extractArchives(archives, destination, { run, sevenZip = '7z', maxBytes }) {
  const extracted = []
  for (const [index, archive] of archives.entries()) {
    const target = join(destination, String(index + 1).padStart(3, '0'))
    let listing
    try { ({ stdout: listing } = await run(sevenZip, ['l', '-slt', '-ba', '-p', '--', archive], 5 * 60_000)) }
    catch (error) {
      if (error?.code === 'ENOENT') throw new Error('The torrent contains archives, but 7-Zip is not installed on the recovery server (apt install 7zip).')
      throw new Error(`Could not read ${basename(archive)}; it may be damaged or password-protected.`)
    }
    checkArchiveListing(listing, maxBytes)
    try { await run(sevenZip, ['x', '-y', '-p', `-o${target}`, '--', archive], 30 * 60_000) }
    catch { throw new Error(`Could not extract ${basename(archive)}; it may be damaged, incomplete or password-protected.`) }
    extracted.push(target)
  }
  return extracted
}

// A torrent whose import failed stays in qBittorrent with its data. Adding the same link again reuses it, so the
// retry imports straight away instead of downloading again. Only a torrent Tomify added, and that no live job is
// using, is reused; anything else is added as normal (and qBittorrent refuses a duplicate as before).
export async function findReusableTorrent(provenance, { client, loadJob, savedJobs }) {
  let hash = provenance?.infoHash || null
  // A .torrent file link carries no info hash, so look for it on an earlier failed job for the same link.
  if (!hash && provenance?.resultId) {
    const earlier = (await savedJobs()).find((job) => job?.downloader === 'qbittorrent' && job.status === 'failed' && job.result?.resultId === provenance.resultId && /^[a-f0-9]{40}$/.test(job.torrent?.infoHash || ''))
    hash = earlier?.torrent.infoHash || null
  }
  if (!hash) return null
  const info = await client.findByHash(hash)
  if (!info) return null
  const tags = text(info.tags).split(',').map(text).filter((value) => value.startsWith('tomify-'))
  if (!tags.length) return null
  for (const tag of tags) {
    const job = await loadJob(tag.slice('tomify-'.length))
    if (job && job.status !== 'failed') return null
  }
  return { hash: text(info.hash).toLowerCase(), tags }
}
