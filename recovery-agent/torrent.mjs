import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { isIP } from 'node:net'
import { usenetSearchQuery, usenetSearchSpec } from './usenet.mjs'

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
// displayUrl drops trackers and query strings, which can carry private-tracker passkeys.
export function parseTorrentLink(value) {
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
  if (privateHost(url.hostname)) throw new Error('Torrent file links must point to a public host.')
  let name = null
  try { name = decodeURIComponent(basename(url.pathname)).replace(/\.torrent$/i, '').trim().slice(0, 500) || null } catch { name = null }
  return { type: 'url', link: url.toString(), infoHash: null, name, displayUrl: `${url.origin}${url.pathname}` }
}

// A wanted item without a track title is an album (or "anything by this artist"), so the whole download is imported.
export function torrentSearchMode(track) {
  return text(track?.title) ? 'track' : 'release'
}

export function torrentCandidate(value, track) {
  const parsed = parseTorrentLink(value)
  const resultId = parsed.infoHash || createHash('sha256').update(parsed.link).digest('hex')
  const searchMode = torrentSearchMode(track)
  return {
    externalId: createHash('sha256').update(`torrent\0${resultId}`).digest('hex'), url: parsed.displayUrl,
    title: parsed.name || (parsed.infoHash ? `Torrent ${parsed.infoHash.slice(0, 12)}` : 'Torrent file link'), channel: 'Torrent link', duration: null, thumbnail: null,
    provenance: { providerType: 'torrent', providerId: 'torrent-link', providerName: 'Torrent link', resultId, linkType: parsed.type, infoHash: parsed.infoHash, link: parsed.link, displayUrl: parsed.displayUrl, postedTitle: parsed.name, searchMode, searchFields: null },
  }
}

function siteName(value) {
  try { return new URL(text(value)).hostname.replace(/^www\./, '') || null } catch { return null }
}

// Turns qBittorrent search-plugin results into Recovery candidates. Only results with at least one seed are kept
// (plugins report -1 when they do not know), the best-seeded come first, and links qBittorrent could not be
// given safely (private hosts, credentials, plugin-only URLs) are dropped.
export function torrentSearchCandidates(results, track, input) {
  const { fields: searchFields, mode: searchMode } = usenetSearchSpec(input, track)
  const seen = new Set()
  const candidates = []
  for (const result of Array.isArray(results) ? results : []) {
    const seeds = number(result?.nbSeeders)
    if (seeds === null || seeds < 1) continue
    let parsed
    try { parsed = parseTorrentLink(result?.fileUrl) } catch { continue }
    const resultId = parsed.infoHash || createHash('sha256').update(parsed.link).digest('hex')
    if (seen.has(resultId)) continue
    seen.add(resultId)
    let detailsUrl = null
    try { const details = new URL(text(result?.descrLink)); if (['http:', 'https:'].includes(details.protocol) && !details.username && !details.password) detailsUrl = details.toString() } catch { /* The plugin gave no details page. */ }
    const leechers = number(result?.nbLeechers)
    const size = number(result?.fileSize)
    const site = siteName(result?.siteUrl) || siteName(detailsUrl) || 'Torrent search'
    const title = text(result?.fileName).slice(0, 500) || parsed.name || `Torrent ${resultId.slice(0, 12)}`
    candidates.push({
      externalId: createHash('sha256').update(`torrent\0${resultId}`).digest('hex'), url: detailsUrl || parsed.displayUrl,
      title, channel: site, duration: null, thumbnail: null,
      provenance: { providerType: 'torrent', providerId: 'qbittorrent-search', providerName: site, resultId, linkType: parsed.type, infoHash: parsed.infoHash, link: parsed.link, displayUrl: parsed.displayUrl, detailsUrl, postedTitle: title, searchMode, searchFields, seeds, peers: leechers !== null && leechers >= 0 ? leechers : null, size: size !== null && size > 0 ? size : null },
    })
  }
  return candidates.sort((a, b) => b.provenance.seeds - a.provenance.seeds).slice(0, SEARCH_RESULT_LIMIT)
}

export function torrentConfig(env = process.env) {
  const url = text(env.TOMIFY_QBITTORRENT_URL)
  if (!url) return null
  const configuredMax = Number(env.TOMIFY_TORRENT_MAX_BYTES || 4 * 1024 * 1024 * 1024)
  return {
    type: 'qbittorrent', url: serviceUrl(url, 'qBittorrent URL'), username: text(env.TOMIFY_QBITTORRENT_USERNAME), password: text(env.TOMIFY_QBITTORRENT_PASSWORD),
    category: text(env.TOMIFY_TORRENT_CATEGORY) || 'tomify', downloadRoot: text(env.TOMIFY_QBITTORRENT_DOWNLOAD_DIR) || null,
    maxBytes: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 4 * 1024 * 1024 * 1024,
  }
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

  async function ensureCategory(cookie, savePath) {
    const { response } = await call(cookie, 'torrents/createCategory', { category: config.category, savePath }, 'qBittorrent category')
    // 409 means the category already exists, which is fine.
    if (!response.ok && response.status !== 409) throw new Error(`qBittorrent category returned HTTP ${response.status}.`)
  }

  return {
    async add(link, { tag, savePath }) {
      const cookie = await session()
      await ensureCategory(cookie, savePath)
      const { response, body } = await call(cookie, 'torrents/add', { urls: link, category: config.category, tags: tag, savepath: savePath }, 'qBittorrent add')
      if (!response.ok) throw new Error(`qBittorrent add returned HTTP ${response.status}.`)
      if (/^fails/i.test(text(body))) throw new Error('qBittorrent refused the torrent link (it may already be in qBittorrent).')
      return { downloader: 'qbittorrent', remoteId: tag }
    },
    async info(tag) {
      const cookie = await session()
      const url = new URL(`${config.url}/api/v2/torrents/info`)
      url.searchParams.set('tag', tag)
      const response = await fetchImpl(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
      const torrents = await response.json()
      // Older qBittorrent releases ignore the tag filter, so match the tag here too.
      return (Array.isArray(torrents) ? torrents : []).find((torrent) => text(torrent?.tags).split(',').map(text).includes(tag)) || null
    },
    // Runs a search across qBittorrent's enabled search plugins (Music category) and returns the raw results.
    // Plugins run inside qBittorrent on the media server; the search is refused while qBittorrent reports it is
    // offline, which is what it reports when the VPN interface it is bound to is down.
    async search(pattern, { timeoutMs = SEARCH_TIMEOUT_MS, pollMs = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
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
      if (!(Array.isArray(plugins) ? plugins : []).some((plugin) => plugin?.enabled)) throw new Error('qBittorrent has no search plugins enabled. Install them as described in docs/RECOVERY.md.')
      const started = await call(cookie, 'search/start', { pattern, plugins: 'enabled', category: 'music' }, 'qBittorrent search')
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
    },
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
