// Tomifin Downloader: search the torrent sources Recovery already uses (qBittorrent's search plugins and any
// Prowlarr or Jackett indexers) and, when set up, its Newznab indexers, for films and TV, and queue a chosen result
// for the Family or Private Jellyfin library: torrents in the same qBittorrent, NZBs in the same SABnzbd
// (tomifin-usenet.mjs). While a torrent downloads, its data is kept in a hidden folder of its own inside the library
// (.tomifin-incomplete/<job id>), and qBittorrent moves it into the library when it finishes.
//
// The browser never sees or sends a link. A search keeps its results here for an hour and the browser names one by
// id, so only links this agent's own search produced reach a downloader. A pasted link or uploaded file (Add link) is
// checked here (tomifin-links.mjs) and becomes such a result too. Destinations come only from the agent's environment
// and are chosen by name ("family" or "private"); the agent decides the downloader.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { parseTorrentLink, safeDetailsUrl, seededTorrentResults } from './torrent.mjs'
import { configuredTorrentIndexers, isIndexerLink } from './torrent-indexers.mjs'
import { JellyfinAuthError } from './jellyfin.mjs'
import { LinkError, createLinkFetcher, inspectSubmission } from './tomifin-links.mjs'
import { TomifinUsenetError } from './tomifin-usenet.mjs'

export const TOMIFIN_DESTINATIONS = Object.freeze({
  family: Object.freeze({ id: 'family', label: 'Family', env: 'TOMIFY_TOMIFIN_FAMILY_DIR', qbittorrentEnv: 'TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR', importEnv: 'TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR', category: 'tomifin-family' }),
  private: Object.freeze({ id: 'private', label: 'Private', env: 'TOMIFY_TOMIFIN_PRIVATE_DIR', qbittorrentEnv: 'TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR', category: 'tomifin-private' }),
})

// Search-plugin category and Torznab categories (2000 Movies, 5000 TV) for each kind of search.
export const TOMIFIN_SEARCH_KINDS = Object.freeze({
  video: { plugin: 'all', indexers: '2000,5000' },
  movies: { plugin: 'movies', indexers: '2000' },
  tv: { plugin: 'tv', indexers: '5000' },
})

export const DEFAULT_TOMIFIN_MAX_BYTES = 200 * 1024 ** 3
const RESULT_LIMIT = 50
const RESULT_TTL_MS = 60 * 60_000
const RESULT_CACHE_LIMIT = 1000
// Added links keep their checked .torrent or NZB file in memory until queued, so only a few are kept.
const LINK_RESULT_LIMIT = 20
// A freshly added magnet can take a moment to appear in qBittorrent's list.
const MISSING_GRACE_MS = 2 * 60_000
// How long a download qBittorrent never confirmed or refused (the add timed out, say) is kept while Tomifin waits for
// the torrent to appear.
export const UNCONFIRMED_KEEP_MS = 15 * 60_000
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const RESULT_ID = /^[a-f0-9]{64}$/
const TOMIFIN_TAG = /^tomifin-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
// The hidden folder inside each library that holds unfinished downloads, one folder per job.
export const STAGING_FOLDER = '.tomifin-incomplete'
const COMPLETE_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP', 'checkingUP'])
const PAUSED_STATES = new Set(['pausedDL', 'stoppedDL'])
const FAILED_STATES = new Set(['error', 'missingFiles'])

export class TomifinError extends Error {
  constructor(code, message) { super(message); this.name = 'TomifinError'; this.code = code }
}

function text(value) { return String(value ?? '').trim() }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function nonNegative(value) { const parsed = number(value); return parsed !== null && parsed >= 0 ? Math.round(parsed) : null }
function within(child, parent) { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }
function overlaps(a, b) { return within(a, b) || within(b, a) }

function directory(value, label) {
  const raw = text(value)
  if (!raw) return null
  if (!isAbsolute(raw)) throw new Error(`${label} must be an absolute path.`)
  const path = resolve(raw)
  if (path === sep) throw new Error(`${label} must not be the filesystem root.`)
  return path
}

// Reads the two destinations from the agent's environment. Tomifin stays off (with a problem to report) unless both
// are set, separate from each other and from every folder Recovery owns, so a mistake can never put Private media
// inside the Family library or send downloads into the music library.
export function tomifinConfig(env = process.env, { torrentAvailable = false, reservedPaths = [] } = {}) {
  const off = (problem) => ({ enabled: false, problem, destinations: {} })
  let destinations
  try {
    destinations = Object.fromEntries(Object.values(TOMIFIN_DESTINATIONS).map((definition) => {
      const hostPath = directory(env[definition.env], definition.env)
      const qbittorrentPath = directory(env[definition.qbittorrentEnv], definition.qbittorrentEnv) || hostPath
      // With an importer (Family's, recovery-agent/family-import.mjs), torrents are saved in a hidden subfolder of the
      // library, keep seeding when finished, and the importer publishes clean hardlinks into the library itself.
      const subfolder = definition.importEnv ? text(env[definition.importEnv]) : ''
      if (subfolder && !/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(subfolder)) throw new Error(`${definition.importEnv} must be one hidden folder name such as .downloads.`)
      const saveQbittorrentPath = subfolder && qbittorrentPath ? `${qbittorrentPath.replace(/\/+$/, '')}/${subfolder}` : qbittorrentPath
      return [definition.id, { id: definition.id, label: definition.label, category: definition.category, hostPath, qbittorrentPath, saveQbittorrentPath, imports: Boolean(subfolder) }]
    }))
  } catch (error) { return off(error.message) }
  const { family, private: privateDestination } = destinations
  if (!family.hostPath || !privateDestination.hostPath) return off(`Set ${TOMIFIN_DESTINATIONS.family.env} and ${TOMIFIN_DESTINATIONS.private.env} to turn Tomifin Downloader on.`)
  if (overlaps(family.hostPath, privateDestination.hostPath) || overlaps(family.qbittorrentPath, privateDestination.qbittorrentPath)) return off('The Family and Private folders must be separate, and neither may be inside the other.')
  for (const reserved of reservedPaths.filter(Boolean).map((path) => resolve(path))) {
    if (overlaps(family.hostPath, reserved) || overlaps(privateDestination.hostPath, reserved)) return off(`The Family and Private folders must be separate from ${reserved}.`)
  }
  if (!torrentAvailable) return off('Tomifin Downloader needs qBittorrent (TOMIFY_QBITTORRENT_URL and TOMIFY_TORRENT_DOWNLOAD_DIR).')
  const configuredMax = Number(env.TOMIFY_TOMIFIN_MAX_BYTES || DEFAULT_TOMIFIN_MAX_BYTES)
  return { enabled: true, problem: null, destinations, maxBytes: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_TOMIFIN_MAX_BYTES }
}

// Quality hints from a release name, for display only.
export function qualityFromTitle(title) {
  const name = ` ${text(title)} `.replace(/[._]/g, ' ')
  const resolution = /\b(2160p|4k|uhd)\b/i.test(name) ? '2160p' : name.match(/\b(1080|720|576|480)[pi]\b/i)?.[1]?.concat('p') || null
  const hdr = /\b(dv|dovi|dolby ?vision)\b/i.test(name) ? 'Dolby Vision' : /\bhdr10\+|\bhdr10plus\b/i.test(name) ? 'HDR10+' : /\bhdr(10)?\b/i.test(name) ? 'HDR' : null
  const codec = /\b(x265|h ?265|hevc)\b/i.test(name) ? 'HEVC' : /\b(x264|h ?264|avc)\b/i.test(name) ? 'H.264' : /\bav1\b/i.test(name) ? 'AV1' : /\bxvid\b/i.test(name) ? 'XviD' : null
  const source = /\bremux\b/i.test(name) ? 'Remux' : /\b(blu[ -]?ray|bdrip|brrip)\b/i.test(name) ? 'BluRay' : /\bweb[ -]?dl\b/i.test(name) ? 'WEB-DL' : /\bweb[ -]?rip\b/i.test(name) ? 'WEBRip' : /\bhdtv\b/i.test(name) ? 'HDTV' : /\bdvd[ -]?rip\b|\bdvd\b/i.test(name) ? 'DVD' : /\b(cam|hdcam|telesync|hdts)\b/i.test(name) ? 'CAM' : null
  return { resolution, hdr, codec, source }
}

export function validSearchQuery(value) {
  const query = text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (query.length < 2) throw new TomifinError('invalid-query', 'Type at least two characters to search.')
  if (query.length > 200) throw new TomifinError('invalid-query', 'The search is too long (200 characters at most).')
  return query
}

// One qBittorrent torrents/info entry as Tomifin's status: queued, downloading, stalled, paused, completed or failed.
export function tomifinTorrentState(torrent, { createdAt, now = Date.now(), maxBytes = DEFAULT_TOMIFIN_MAX_BYTES } = {}) {
  if (!torrent) {
    const age = now - Date.parse(createdAt || '')
    if (Number.isFinite(age) && age < MISSING_GRACE_MS) return { status: 'queued', message: 'Waiting for qBittorrent' }
    return { status: 'failed', message: 'The torrent is no longer in qBittorrent.' }
  }
  const state = text(torrent.state)
  const size = number(torrent.total_size) || number(torrent.size) || 0
  if (size > maxBytes) return { status: 'failed', message: 'The torrent is larger than the download limit (TOMIFY_TOMIFIN_MAX_BYTES), so it was stopped.' }
  if (FAILED_STATES.has(state)) return { status: 'failed', message: state === 'missingFiles' ? 'qBittorrent reports the files are missing.' : 'qBittorrent reported an error for this torrent.' }
  if (COMPLETE_STATES.has(state) && number(torrent.progress) >= 1) return { status: 'completed', message: null }
  if (PAUSED_STATES.has(state)) return { status: 'paused', message: 'Paused' }
  if (state === 'queuedDL') return { status: 'queued', message: 'Queued in qBittorrent' }
  if (state === 'stalledDL') return { status: 'stalled', message: 'Waiting for peers' }
  if (state === 'metaDL' || state === 'forcedMetaDL') return { status: 'downloading', message: 'Fetching torrent details' }
  if (state.startsWith('checking')) return { status: 'downloading', message: 'Checking files' }
  if (state === 'moving') return { status: 'downloading', message: 'Moving files' }
  return { status: 'downloading', message: null }
}

function tag(id) { return `tomifin-${id}` }

// What a log line may say about a download: a searched result's title, but nothing from an added link (its name can
// come from the link itself).
function logName(job) { return job?.origin === 'link' ? `an added ${job.linkType === 'nzb' ? 'NZB' : job.linkType === 'magnet' ? 'magnet' : 'torrent'} (${String(job.id).slice(0, 8)})` : `"${String(job?.title).slice(0, 120)}"` }

// The fields of a result the browser may see. Links, hashes, GUIDs and files stay here.
function visibleResult(result) {
  return {
    id: result.id, title: result.title, source: result.source, size: result.size ?? null, type: result.type, linkType: result.linkType,
    seeders: result.type === 'torrent' ? result.seeders ?? null : null, leechers: result.type === 'torrent' ? result.leechers ?? null : null,
    grabs: result.grabs ?? null, ageDays: result.ageDays ?? null, detailsUrl: result.detailsUrl ?? null, quality: result.quality, origin: result.origin || 'search',
  }
}

// NZB results found on several indexers are merged only when the posted title and the exact size are identical; the
// same cleaned-up name with a different size is a different release.
// Conservative: the same indexer entry, or the same release name (ignoring case and separators) with sizes within 1 %
// (providers count a post's size slightly differently). Anything less certain is shown twice rather than hidden.
function nzbEntryKey(entry) { return `${entry.provider || 'newznab'}\0${entry.indexerId}\0${entry.guid || entry.collectionId}` }
function releaseName(title) { return text(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
function dedupeNzbs(entries) {
  const seen = new Set()
  const kept = []
  for (const entry of entries) {
    if (seen.has(nzbEntryKey(entry))) continue
    seen.add(nzbEntryKey(entry))
    const name = releaseName(entry.title)
    if (entry.size && kept.some((other) => other.size && releaseName(other.title) === name && Math.abs(other.size - entry.size) <= Math.max(other.size, entry.size) * 0.01)) continue
    kept.push(entry)
  }
  return kept
}

// Only links qBittorrent can certainly use: magnets, .torrent files and download links from a configured Prowlarr or
// Jackett. Plugin results that point at a web page (which only the plugin itself could turn into a torrent) are left
// out rather than offered as a download that would fail.
export function qbittorrentReady(parsed, indexers = configuredTorrentIndexers()) {
  if (parsed.type === 'magnet') return true
  try { return /\.torrent$/i.test(new URL(parsed.link).pathname) || isIndexerLink(parsed.link, indexers) } catch { return false }
}

function torrentHasTag(torrent, value) { return text(torrent?.tags).split(',').map(text).includes(value) }

// Maps a path in qBittorrent's view of the filesystem to the agent's, and refuses anything outside the destination.
export function hostContentPath(contentPath, destination) {
  const reported = text(contentPath)
  if (!reported || !isAbsolute(reported)) return null
  const normalised = normalize(reported)
  if (!within(normalised, destination.qbittorrentPath)) return null
  const mapped = resolve(destination.hostPath, '.' + sep + normalised.slice(destination.qbittorrentPath.length))
  // Only something strictly inside the library folder, never the folder itself.
  return within(mapped, destination.hostPath) && mapped !== destination.hostPath ? mapped : null
}

// Where qBittorrent keeps one job's unfinished data, in qBittorrent's view of the filesystem. The folder is named after
// the job's random id, so nothing else ever writes into it.
export function stagingPath(destination, id) {
  return `${(destination.saveQbittorrentPath || destination.qbittorrentPath).replace(/\/+$/, '')}/${STAGING_FOLDER}/${id}`
}

// Whether cancelling may delete a torrent's data: only an unfinished download whose data qBittorrent reports is
// strictly inside that job's own staging folder. Anything in the library itself (a finished download, one being
// moved there, or one an older qBittorrent saved straight into the library) is always kept.
export function partialDataDeletable(torrent, destination, id) {
  if (!torrent || !destination) return false
  const state = text(torrent.state)
  if (state === 'moving' || COMPLETE_STATES.has(state) || (number(torrent.progress) || 0) >= 1) return false
  const reported = text(torrent.content_path)
  if (!reported || !isAbsolute(reported)) return false
  const staging = normalize(stagingPath(destination, id))
  const content = normalize(reported)
  if (content === staging || !within(content, staging)) return false
  const downloadPath = text(torrent.download_path)
  return !downloadPath || normalize(downloadPath).replace(/\/+$/, '') === staging
}

// Whether a torrent has finished and qBittorrent has moved its data out of the staging folder into the library, so
// it can be taken out of qBittorrent without touching the files.
export function finishedInLibrary(torrent, destination, id) {
  // A destination with an importer keeps its finished torrents seeding: they are the importer's source.
  if (!torrent || !destination || destination.imports) return false
  const state = text(torrent.state)
  if (!COMPLETE_STATES.has(state) || state === 'checkingUP' || (number(torrent.progress) || 0) < 1) return false
  const reported = text(torrent.content_path)
  if (!reported || !isAbsolute(reported)) return false
  const content = normalize(reported)
  return within(content, destination.qbittorrentPath) && content !== normalize(destination.qbittorrentPath) && !within(content, normalize(stagingPath(destination, id)))
}

function torrentSize(torrent) { return Math.max(number(torrent?.total_size) || 0, number(torrent?.size) || 0) }

// vpnStatus is the agent's NordVPN status (vpn.mjs), when VPN control is turned on there.
// usenet: the Usenet backend (createTomifinUsenet), or null when Usenet is not set up. fetchLink: how added links are
// fetched (createLinkFetcher), with the configured indexers' hosts as the only private hosts allowed.
export function createTomifinController({ config, client, stateRoot, usenet = null, fetchLink = createLinkFetcher(), now = () => Date.now(), randomId = randomUUID, log = () => {}, intervalMs = 10_000, vpnStatus = null }) {
  const jobsRoot = resolve(stateRoot, 'tomifin')
  const results = new Map()
  const usenetReady = () => Boolean(usenet?.available)
  // Search results and info hashes being queued right now, so a double click or retry cannot add a torrent twice.
  const queuing = new Set()

  function requireEnabled() {
    if (!config?.enabled || !client) throw new TomifinError('not-configured', config?.problem || 'Tomifin Downloader is not configured on the media server.')
  }

  function destinationFor(value) {
    const id = text(value).toLowerCase()
    if (!Object.hasOwn(TOMIFIN_DESTINATIONS, id)) throw new TomifinError('invalid-destination', 'Choose Family or Private before downloading.')
    return config.destinations[id]
  }

  function jobPath(id) {
    if (!JOB_ID.test(text(id))) throw new TomifinError('invalid-job', 'Unknown download.')
    const path = resolve(jobsRoot, `${id}.json`)
    if (!within(path, jobsRoot)) throw new TomifinError('invalid-job', 'Unknown download.')
    return path
  }

  async function saveJob(job) {
    await mkdir(jobsRoot, { recursive: true, mode: 0o700 })
    const path = jobPath(job.id)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }

  async function loadJob(id) {
    try { return JSON.parse(await readFile(jobPath(id), 'utf8')) }
    catch (error) { if (error?.code === 'ENOENT') throw new TomifinError('not-found', 'That download is no longer listed.'); throw error }
  }

  async function savedJobs() {
    const names = await readdir(jobsRoot).catch(() => [])
    const jobs = []
    for (const name of names) {
      if (!name.endsWith('.json') || !JOB_ID.test(name.slice(0, -5))) continue
      const job = await loadJob(name.slice(0, -5)).catch(() => null)
      if (job) jobs.push(job)
    }
    return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  function rememberResults(found) {
    const expiresAt = now() + RESULT_TTL_MS
    for (const [key, value] of results) if (value.expiresAt <= now()) results.delete(key)
    for (const result of found) {
      results.delete(result.id)
      results.set(result.id, { ...result, expiresAt })
    }
    while (results.size > RESULT_CACHE_LIMIT) results.delete(results.keys().next().value)
    const links = [...results.values()].filter((value) => value.origin === 'link')
    for (const value of links.slice(0, Math.max(0, links.length - LINK_RESULT_LIMIT))) results.delete(value.id)
  }

  async function deleteJob(id) { await unlink(jobPath(id)).catch((error) => { if (error?.code !== 'ENOENT') throw error }) }
  const store = { saveJob, deleteJob }
  const isUsenetJob = (job) => job.downloader === 'sabnzbd'

  // Every torrent in Tomifin's two categories, from one torrents/info call per destination.
  async function tomifinTorrents() {
    const categories = Object.values(config.destinations).map((destination) => destination.category)
    return (await Promise.all(categories.map((category) => client.list(category)))).flat()
  }

  function torrentForJob(torrents, job) { return torrents.find((torrent) => torrentHasTag(torrent, tag(job.id))) || null }

  // Keeps Tomifin's records and qBittorrent in step:
  // - a torrent carrying a Tomifin tag with no job record (the record could not be written, or was lost) gets one
  //   again, so it can always be seen, paused and removed here. Its files are never deleted on cancel;
  // - a torrent that turns out larger than the download limit once its details arrive is stopped;
  // - a finished download whose files qBittorrent has moved into the library is taken out of qBittorrent (which
  //   also drops its copy of the .torrent file and its resume data), keeping every downloaded file. The job stays
  //   on the list as completed until it is removed there.
  async function reconcile(jobs, torrents) {
    const known = new Set(jobs.map((job) => job.id))
    for (const torrent of torrents) {
      const id = text(torrent.tags).split(',').map(text).map((value) => value.match(TOMIFIN_TAG)?.[1]).find(Boolean)
      const destination = Object.values(config.destinations).find((entry) => entry.category === text(torrent.category))
      if (!id || known.has(id) || !destination) continue
      const job = { id, version: 1, createdAt: new Date(now()).toISOString(), destination: destination.id, title: text(torrent.name).slice(0, 500) || 'Torrent', source: null, size: null, infoHash: text(torrent.hash).toLowerCase() || null, linkType: null, resultId: null, recovered: true }
      try { await saveJob(job); jobs.push(job); known.add(id); log(`Tomifin found "${job.title.slice(0, 120)}" in qBittorrent without a record and is tracking it again`) }
      catch (error) { log(`Tomifin could not record "${job.title.slice(0, 120)}": ${error instanceof Error ? error.message : String(error)}`) }
    }
    // A download whose add was never confirmed: confirmed once its torrent shows up, dropped if it never does.
    for (const job of [...jobs]) {
      if (!job.unconfirmedSince) continue
      if (torrentForJob(torrents, job)) {
        delete job.unconfirmedSince
        await saveJob(job).catch(() => {})
        log(`Tomifin confirmed ${logName(job)} in qBittorrent`)
      } else if (now() - Date.parse(job.unconfirmedSince) > UNCONFIRMED_KEEP_MS) {
        try {
          await unlink(jobPath(job.id))
          jobs.splice(jobs.indexOf(job), 1)
          log(`Tomifin dropped ${logName(job)}: qBittorrent never showed it`)
        } catch (error) { if (error?.code !== 'ENOENT') log(`Tomifin could not drop an unconfirmed download: ${error.message}`) }
      }
    }
    for (const job of jobs) {
      const torrent = torrentForJob(torrents, job)
      if (!torrent || torrentSize(torrent) <= config.maxBytes) continue
      const state = text(torrent.state)
      if (PAUSED_STATES.has(state) || COMPLETE_STATES.has(state)) continue
      try {
        await client.pause(text(torrent.hash).toLowerCase())
        torrent.state = 'stoppedDL'
        log(`Tomifin stopped ${logName(job)}: it is larger than the download limit`)
      } catch (error) { log(`Tomifin could not stop an oversized torrent: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const job of jobs) {
      const torrent = torrentForJob(torrents, job)
      if (!torrent || !finishedInLibrary(torrent, config.destinations[job.destination], job.id)) continue
      // The record is updated first, so a removal that fails is simply tried again next time.
      Object.assign(job, { completedAt: new Date(now()).toISOString(), title: (job.origin === 'link' ? job.title : text(torrent.name).slice(0, 500)) || job.title, size: torrentSize(torrent) || job.size })
      try {
        await saveJob(job)
        await client.remove(text(torrent.hash).toLowerCase(), false)
        torrents.splice(torrents.indexOf(torrent), 1)
        log(`Tomifin finished ${logName(job)} and removed it from qBittorrent; the files stay in ${config.destinations[job.destination].label}`)
      } catch (error) { log(`Tomifin could not remove a finished torrent from qBittorrent: ${error instanceof Error ? error.message : String(error)}`) }
    }
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  function jobView(job, torrent) {
    const destination = config.destinations[job.destination]
    if (!torrent && job.unconfirmedSince) {
      return {
        id: job.id, name: job.title, destination: job.destination, destinationLabel: destination?.label || job.destination, downloader: 'qbittorrent', downloaderLabel: 'qBittorrent', type: 'torrent',
        status: 'queued', message: 'Waiting for qBittorrent to confirm', progress: 0, downloadSpeed: null, uploadSpeed: null, downloaded: null, size: job.size || null,
        eta: null, seeds: null, peers: null, source: job.source || null, createdAt: job.createdAt, canPause: false, canResume: false, keepsFilesOnCancel: true,
      }
    }
    if (!torrent && job.completedAt) {
      return {
        id: job.id, name: job.title, destination: job.destination, destinationLabel: destination?.label || job.destination, downloader: 'qbittorrent', downloaderLabel: 'qBittorrent', type: 'torrent',
        status: 'completed', message: 'In the library', progress: 100, downloadSpeed: null, uploadSpeed: null, downloaded: job.size || null, size: job.size || null,
        eta: null, seeds: null, peers: null, source: job.source || null, createdAt: job.createdAt, canPause: false, canResume: false, keepsFilesOnCancel: true,
      }
    }
    const state = tomifinTorrentState(torrent, { createdAt: job.createdAt, now: now(), maxBytes: config.maxBytes })
    const progress = state.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.floor((number(torrent?.progress) || 0) * 1000) / 10))
    const eta = number(torrent?.eta)
    const size = nonNegative(torrent?.total_size) || nonNegative(torrent?.size) || job.size || null
    const oversized = torrentSize(torrent) > config.maxBytes
    return {
      id: job.id, name: (job.origin === 'link' ? job.title : text(torrent?.name)) || job.title || text(torrent?.name), destination: job.destination, destinationLabel: destination?.label || job.destination, downloader: 'qbittorrent', downloaderLabel: 'qBittorrent', type: 'torrent',
      status: state.status, message: state.status === 'completed' && destination?.imports ? 'Seeding; the Family importer adds it to the library' : state.message, progress,
      downloadSpeed: torrent ? nonNegative(torrent.dlspeed) : null, uploadSpeed: torrent ? nonNegative(torrent.upspeed) : null,
      downloaded: torrent ? nonNegative(torrent.completed ?? torrent.downloaded) : null, size,
      eta: ['downloading', 'stalled'].includes(state.status) && eta !== null && eta >= 0 && eta < 8640000 ? Math.round(eta) : null,
      seeds: torrent ? nonNegative(torrent.num_seeds) : null, peers: torrent ? nonNegative(torrent.num_leechs) : null,
      source: job.source || null, createdAt: job.createdAt,
      canPause: Boolean(torrent) && !oversized && ['queued', 'downloading', 'stalled'].includes(state.status),
      canResume: Boolean(torrent) && !oversized && state.status === 'paused',
      // Only an unfinished download still in its own staging folder has its data deleted on cancel.
      keepsFilesOnCancel: job.recovered === true || !partialDataDeletable(torrent, destination, job.id),
    }
  }

  async function torrentFor(job) {
    const torrent = await client.info(tag(job.id))
    return torrent && torrentHasTag(torrent, tag(job.id)) ? torrent : null
  }

  // Usenet errors and link errors carry their own code and a message that is safe to show.
  function asTomifinError(error) {
    if (error instanceof TomifinUsenetError || error instanceof LinkError) return new TomifinError(error.code, error.message)
    return error
  }

  // The torrent to give qBittorrent for a result: a link from this agent's search (parsed again rather than trusting
  // the cached copy), or the magnet or checked .torrent file of an added link.
  function torrentPayload(result) {
    if (result.origin === 'link') return { link: result.link || null, torrent: result.torrent || null, infoHash: result.infoHash, type: result.linkType === 'magnet' ? 'magnet' : 'file' }
    const parsed = parseTorrentLink(result.link)
    return { link: parsed.link, torrent: null, infoHash: parsed.infoHash, type: parsed.type }
  }

  async function downloadTorrent(result, destination, resultId) {
    const payload = torrentPayload(result)
    const keys = [`result:${resultId}`, ...(payload.infoHash ? [`hash:${payload.infoHash}`] : [])]
    if (keys.some((key) => queuing.has(key))) throw new TomifinError('duplicate', 'This torrent is already being queued.')
    for (const key of keys) queuing.add(key)
    try {
      // A retry of a result already queued (even one whose record outlived the search) is refused, not added twice.
      if ((await savedJobs()).some((job) => job.resultId === resultId || (payload.infoHash && job.infoHash === payload.infoHash))) throw new TomifinError('duplicate', 'This torrent is already in your downloads.')
      if (payload.infoHash && await client.findByHash(payload.infoHash)) throw new TomifinError('duplicate', 'This torrent is already in qBittorrent.')
      const id = randomId()
      const job = {
        id, version: 1, downloader: 'qbittorrent', createdAt: new Date(now()).toISOString(), destination: destination.id, title: result.title, source: result.source,
        size: result.size || null, infoHash: payload.infoHash, linkType: payload.type, resultId, ...(result.origin === 'link' ? { origin: 'link' } : {}),
      }
      // The record is written before qBittorrent hears about the torrent, so a torrent can never be downloading
      // without Tomifin knowing about it. If the record cannot be written, nothing is added.
      await saveJob(job)
      try {
        // Throws unless qBittorrent accepted the torrent, so success is reported only after it acknowledged it.
        await client.add(payload.link, { tag: tag(id), savePath: destination.saveQbittorrentPath || destination.qbittorrentPath, downloadPath: stagingPath(destination, id), category: destination.category, subfolder: true, ...(payload.torrent ? { torrent: payload.torrent } : {}) })
      } catch (error) {
        // Only a definite refusal removes the record. When qBittorrent's answer was lost (a timeout, a dropped
        // connection) it may still have taken the torrent, perhaps without showing it yet, so the record is kept
        // and the regular check (reconcile) confirms it when the torrent appears, or drops it after a while.
        if (error?.rejected === true) {
          await unlink(jobPath(id)).catch((failure) => log(`Tomifin could not remove the record of a download qBittorrent refused: ${failure?.message || failure}`))
          throw error
        }
        if (!await torrentFor(job).catch(() => null)) {
          job.unconfirmedSince = new Date(now()).toISOString()
          await saveJob(job).catch((failure) => log(`Tomifin could not mark a download as unconfirmed: ${failure?.message || failure}`))
          results.delete(resultId)
          log(`Tomifin could not confirm ${logName(job)} with qBittorrent and will keep checking: ${error instanceof Error ? error.message : String(error)}`)
          throw new TomifinError('unconfirmed', 'qBittorrent did not confirm the download. It is on your downloads list while Tomifin checks whether it arrived; do not queue it again.')
        }
      }
      results.delete(resultId)
      log(`Tomifin queued ${logName(job)} in qBittorrent for ${destination.label}`)
      return { job: jobView(job, null) }
    } finally {
      for (const key of keys) queuing.delete(key)
    }
  }

  async function downloadUsenet(result, destination, resultId) {
    if (!usenetReady()) throw new TomifinError('usenet-unavailable', usenet?.status().problem || 'Usenet downloads are not set up on the media server.')
    const keys = [`result:${resultId}`, ...(result.guidKey ? [`guid:${result.guidKey}`] : [])]
    if (keys.some((key) => queuing.has(key))) throw new TomifinError('duplicate', 'This NZB is already being queued.')
    for (const key of keys) queuing.add(key)
    try {
      let jobs = await savedJobs()
      if (jobs.some((job) => job.resultId === resultId || (result.guidKey && job.guidKey === result.guidKey))) throw new TomifinError('duplicate', 'This NZB is already in your downloads.')
      // Fetched and checked here: the indexer's download link (with its API key) never leaves the agent.
      const prepared = result.nzb ? { bytes: result.nzb, nzb: result.parsed } : await usenet.prepare(result).catch((error) => { throw asTomifinError(error) })
      if (prepared.nzb.size > config.maxBytes) throw new TomifinError('too-large', 'This NZB is larger than the download limit (TOMIFY_TOMIFIN_MAX_BYTES).')
      // The strongest identity available: the message-ids it downloads, however the NZB file is formatted.
      const identityKey = `nzb:${prepared.nzb.identity}`
      if (queuing.has(identityKey)) throw new TomifinError('duplicate', 'This NZB is already being queued.')
      queuing.add(identityKey)
      keys.push(identityKey)
      jobs = await savedJobs()
      if (jobs.some((job) => job.nzbIdentity === prepared.nzb.identity)) throw new TomifinError('duplicate', 'This NZB is already in your downloads.')
      await usenet.ensureCategories().catch((error) => { throw asTomifinError(error) })
      const id = randomId()
      const job = {
        id, version: 2, downloader: 'sabnzbd', createdAt: new Date(now()).toISOString(), destination: destination.id, title: result.title, source: result.source,
        size: prepared.nzb.size || result.size || null, resultId, guidKey: result.guidKey || null, nzbIdentity: prepared.nzb.identity, category: usenet.categoryFor(destination.id),
        linkType: 'nzb', ...(result.origin === 'link' ? { origin: 'link' } : {}),
      }
      // Written before SABnzbd hears about it, as for torrents.
      await saveJob(job)
      try {
        const { nzoId } = await usenet.submit(job, prepared.bytes)
        job.remoteId = nzoId
        await saveJob(job).catch((failure) => log(`Tomifin could not save SABnzbd's id for ${logName(job)}: ${failure?.message || failure}`))
      } catch (error) {
        if (error?.rejected === true) {
          await deleteJob(id).catch((failure) => log(`Tomifin could not remove the record of a download SABnzbd refused: ${failure?.message || failure}`))
          throw new TomifinError('sabnzbd-refused', error.message || 'SABnzbd refused the NZB.')
        }
        // Unknown outcome: never submitted again blindly. The job is found by its name (tomifin-<id>) once SABnzbd
        // shows it, or dropped after a while if it never does.
        const remoteId = await usenet.locate(job).catch(() => null)
        if (remoteId) { job.remoteId = remoteId; await saveJob(job).catch(() => {}) }
        else {
          job.unconfirmedSince = new Date(now()).toISOString()
          await saveJob(job).catch((failure) => log(`Tomifin could not mark a download as unconfirmed: ${failure?.message || failure}`))
          results.delete(resultId)
          log(`Tomifin could not confirm ${logName(job)} with SABnzbd and will keep checking`)
          throw new TomifinError('unconfirmed', 'SABnzbd did not confirm the download. It is on your downloads list while Tomifin checks whether it arrived; do not queue it again.')
        }
      }
      results.delete(resultId)
      log(`Tomifin queued ${logName(job)} in SABnzbd for ${destination.label}`)
      return { job: usenet.view(job, null, destination) }
    } finally {
      for (const key of keys) queuing.delete(key)
    }
  }

  // Tomifin's jobs and both downloaders' current state, in step (reconciled) and ready to show.
  async function current() {
    const jobs = await savedJobs()
    const torrentJobs = jobs.filter((job) => !isUsenetJob(job))
    const usenetJobs = jobs.filter(isUsenetJob)
    const [torrents, snapshot] = await Promise.all([tomifinTorrents(), usenetReady() ? usenet.snapshot() : null])
    await reconcile(torrentJobs, torrents)
    if (usenetReady()) await usenet.reconcile(usenetJobs, snapshot, store)
    return { torrentJobs, usenetJobs, torrents, snapshot }
  }

  function usenetView(job, snapshot) {
    const destination = config.destinations[job.destination]
    if (usenet) return usenet.view(job, snapshot, destination)
    return {
      id: job.id, name: job.title, destination: job.destination, destinationLabel: destination?.label || job.destination, downloader: 'sabnzbd', downloaderLabel: 'SABnzbd', type: 'usenet',
      status: 'failed', message: 'Usenet downloads are not set up on the media server.', progress: 0, downloadSpeed: null, uploadSpeed: null, downloaded: null, size: job.size || null,
      eta: null, seeds: null, peers: null, source: job.source || null, createdAt: job.createdAt, canPause: false, canResume: false, keepsFilesOnCancel: true,
    }
  }

  const controller = {
    status() {
      const usenetStatus = usenet ? usenet.status() : { available: false, problem: 'Usenet downloads are not set up on the media server.' }
      return {
        available: Boolean(config?.enabled && client), problem: config?.enabled ? null : (config?.problem || 'Tomifin Downloader is not configured on the media server.'),
        destinations: Object.values(TOMIFIN_DESTINATIONS).map(({ id, label }) => ({ id, label, available: Boolean(config?.enabled && config.destinations[id]) })),
        kinds: Object.keys(TOMIFIN_SEARCH_KINDS),
        downloaders: { torrent: { available: Boolean(config?.enabled && client) }, usenet: { available: Boolean(config?.enabled && usenetStatus.available), problem: usenetStatus.available ? null : usenetStatus.problem, search: { available: Boolean(config?.enabled && usenetStatus.available && usenetStatus.search?.available), providers: usenetStatus.search?.providers || [], problem: usenetStatus.search?.problem || usenetStatus.problem || null } } },
      }
    },

    // The VPN as Tomifin's page shows it: whether qBittorrent (which is bound to the VPN) has a connection, and what
    // NordVPN reports when the agent can ask it. No addresses are returned.
    async vpn() {
      requireEnabled()
      const [qbittorrent, nordvpn] = await Promise.all([
        client.connection().catch(() => 'unknown'),
        vpnStatus ? vpnStatus().catch(() => null) : null,
      ])
      const nord = nordvpn?.control === 'enabled' && nordvpn.state !== 'unavailable'
        ? { state: ['connected', 'disconnected', 'connecting'].includes(nordvpn.state) ? nordvpn.state : 'unknown', country: text(nordvpn.country).slice(0, 80) || null, city: text(nordvpn.city).slice(0, 80) || null, server: text(nordvpn.server).slice(0, 120) || null }
        : null
      const state = qbittorrent === 'disconnected' || nord?.state === 'disconnected' ? 'down'
        : nord?.state === 'connecting' ? 'connecting'
        : ['connected', 'firewalled'].includes(qbittorrent) && (!nord || nord.state === 'connected') ? 'connected'
        : 'unknown'
      return { state, qbittorrent, nordvpn: nord }
    },

    // Torrents and (when set up) NZBs at once, in one list. Either source failing leaves the other's results, with a
    // warning; the search fails only when every source does.
    async search(body) {
      requireEnabled()
      const query = validSearchQuery(body?.query)
      const kindId = text(body?.kind || 'video').toLowerCase()
      if (!Object.hasOwn(TOMIFIN_SEARCH_KINDS, kindId)) throw new TomifinError('invalid-kind', 'Choose films, TV or both.')
      const kind = TOMIFIN_SEARCH_KINDS[kindId]
      const torrentSearch = client.search(query, { category: kind.plugin, indexerCategories: kind.indexers }).then((raw) => seededTorrentResults(raw).filter((result) => qbittorrentReady(result.parsed)).slice(0, RESULT_LIMIT).map((result) => ({
        id: createHash('sha256').update(`tomifin\0${result.resultId}`).digest('hex'),
        title: result.title, source: result.site, size: result.size, seeders: result.seeds, leechers: result.leechers,
        // Only torrents reach this list: qBittorrent-ready magnet links and .torrent file links.
        type: 'torrent', linkType: result.parsed.type === 'magnet' ? 'magnet' : 'torrent-file',
        detailsUrl: result.detailsUrl, quality: qualityFromTitle(result.title),
        link: result.parsed.link, infoHash: result.parsed.infoHash,
      })))
      const usenetSearch = usenetReady() && usenet.searchAvailable ? usenet.search(query, kindId) : null
      const [torrents, nzbs] = await Promise.allSettled([torrentSearch, usenetSearch || Promise.resolve(null)])
      if (torrents.status === 'rejected' && (!usenetSearch || nzbs.status === 'rejected')) throw torrents.reason
      const warnings = []
      if (torrents.status === 'rejected') warnings.push(`Torrent search failed: ${torrents.reason instanceof Error ? torrents.reason.message : 'unknown error'}`)
      if (usenetSearch && nzbs.status === 'rejected') warnings.push(`Usenet search failed: ${nzbs.reason instanceof Error ? nzbs.reason.message : 'unknown error'}`)
      if (nzbs.status === 'fulfilled' && nzbs.value?.failed) warnings.push(nzbs.value.failedNames?.length ? `Usenet search: ${nzbs.value.failedNames.join(', ')} did not answer.` : `${nzbs.value.failed} Usenet indexer${nzbs.value.failed === 1 ? '' : 's'} did not answer.`)
      const usenetResults = nzbs.status === 'fulfilled' && nzbs.value ? dedupeNzbs(nzbs.value.results).slice(0, RESULT_LIMIT).map((entry) => ({
        id: createHash('sha256').update(`tomifin-usenet\0${nzbEntryKey(entry)}`).digest('hex'),
        title: entry.title, source: entry.indexerName, size: entry.size, ageDays: entry.ageDays, grabs: entry.grabs, seeders: null, leechers: null,
        // NZBIndex's details page names its collection id, which stays on the agent, so it gets no link.
        type: 'usenet', linkType: 'nzb', detailsUrl: entry.provider === 'nzbindex' ? null : safeDetailsUrl(entry.comments), quality: qualityFromTitle(entry.title),
        provider: entry.provider || 'newznab', indexerId: entry.indexerId, guid: entry.guid || null, collectionId: entry.collectionId || null, guidKey: nzbEntryKey(entry),
      })) : []
      const found = [...(torrents.status === 'fulfilled' ? torrents.value : []), ...usenetResults]
      rememberResults(found)
      log(`Tomifin search (${kindId}) returned ${found.length} result${found.length === 1 ? '' : 's'} (${usenetResults.length} Usenet)`)
      return { query, kind: kindId, results: found.map(visibleResult), warnings, usenet: Boolean(usenetReady() && usenet.searchAvailable) }
    },

    // Add link: checks one pasted magnet, .torrent or .nzb link, or an uploaded file, and turns it into a result the
    // page can queue like any other. The type is worked out here from the content; the browser's word is not asked.
    async link(body) {
      requireEnabled()
      let parsed
      try { parsed = await inspectSubmission({ link: body?.link, file: body?.file }, { fetchLink, maxBytes: config.maxBytes }) }
      catch (error) { throw asTomifinError(error) }
      if (parsed.kind === 'nzb' && !usenetReady()) throw new TomifinError('usenet-unavailable', `This is an NZB, but Usenet downloads are not set up on the media server${usenet?.status().problem ? `: ${usenet.status().problem}` : '.'}`)
      const jobs = await savedJobs()
      if (parsed.kind === 'nzb' ? jobs.some((job) => job.nzbIdentity === parsed.identity) : jobs.some((job) => job.infoHash === parsed.id)) throw new TomifinError('duplicate', 'This is already in your downloads.')
      if (parsed.kind !== 'nzb' && await client.findByHash(parsed.id)) throw new TomifinError('duplicate', 'This torrent is already in qBittorrent.')
      const fallback = parsed.kind === 'nzb' ? 'NZB download' : `Torrent ${parsed.id.slice(0, 12)}`
      const title = parsed.name || fallback
      const common = { id: createHash('sha256').update(`tomifin-link\0${randomUUID()}`).digest('hex'), origin: 'link', title, source: 'Added link', size: parsed.size || null, detailsUrl: null, quality: qualityFromTitle(title), ageDays: null, grabs: null }
      const result = parsed.kind === 'magnet' ? { ...common, type: 'torrent', linkType: 'magnet', link: parsed.link, infoHash: parsed.id, seeders: null, leechers: null }
        : parsed.kind === 'torrent' ? { ...common, type: 'torrent', linkType: 'torrent-file', torrent: parsed.bytes, infoHash: parsed.id, seeders: null, leechers: null }
        : { ...common, type: 'usenet', linkType: 'nzb', nzb: parsed.bytes, parsed: { identity: parsed.identity, size: parsed.size, name: parsed.name } }
      rememberResults([result])
      log(`Tomifin checked an added ${parsed.kind === 'nzb' ? 'NZB' : parsed.kind}`)
      return { detected: parsed.kind, result: visibleResult(result) }
    },

    async download(body) {
      requireEnabled()
      const destination = destinationFor(body?.destination)
      const resultId = text(body?.resultId).toLowerCase()
      if (!RESULT_ID.test(resultId)) throw new TomifinError('invalid-result', 'Choose a search result to download.')
      const result = results.get(resultId)
      if (!result || result.expiresAt <= now()) throw new TomifinError('result-expired', 'That search result has expired. Search again, then choose it.')
      if (result.size && result.size > config.maxBytes) throw new TomifinError('too-large', `This ${result.type === 'usenet' ? 'NZB' : 'torrent'} is larger than the download limit (TOMIFY_TOMIFIN_MAX_BYTES).`)
      // The downloader follows from the result: never from anything the browser sends.
      return result.type === 'usenet' ? downloadUsenet(result, destination, resultId) : downloadTorrent(result, destination, resultId)
    },

    async list() {
      requireEnabled()
      const { torrentJobs, usenetJobs, torrents, snapshot } = await current()
      if (usenetReady()) usenet.process(usenetJobs, snapshot, store)
      const views = [...torrentJobs.map((job) => jobView(job, torrentForJob(torrents, job))), ...usenetJobs.map((job) => usenetView(job, snapshot))]
      return { jobs: views.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }
    },

    async pause(body) {
      requireEnabled()
      const job = await loadJob(body?.id)
      if (isUsenetJob(job)) {
        if (!usenetReady()) throw new TomifinError('usenet-unavailable', 'Usenet downloads are not set up on the media server.')
        await usenet.pause(job).catch((error) => { throw asTomifinError(error) })
        return { job: usenetView(job, await usenet.snapshot()) }
      }
      const torrent = await torrentFor(job)
      if (!torrent) throw new TomifinError('not-in-qbittorrent', 'The torrent is no longer in qBittorrent.')
      await client.pause(text(torrent.hash).toLowerCase())
      return { job: jobView(job, { ...torrent, state: 'stoppedDL' }) }
    },

    async resume(body) {
      requireEnabled()
      const job = await loadJob(body?.id)
      if (isUsenetJob(job)) {
        if (!usenetReady()) throw new TomifinError('usenet-unavailable', 'Usenet downloads are not set up on the media server.')
        await usenet.resume(job).catch((error) => { throw asTomifinError(error) })
        return { job: usenetView(job, await usenet.snapshot()) }
      }
      const torrent = await torrentFor(job)
      if (!torrent) throw new TomifinError('not-in-qbittorrent', 'The torrent is no longer in qBittorrent.')
      if (torrentSize(torrent) > config.maxBytes) throw new TomifinError('too-large', 'This torrent is larger than the download limit (TOMIFY_TOMIFIN_MAX_BYTES), so it cannot be resumed.')
      await client.resume(text(torrent.hash).toLowerCase())
      return { job: jobView(job, { ...torrent, state: 'queuedDL' }) }
    },

    // Takes the download out of its downloader and off the list. Downloaded data is deleted only for an unfinished
    // download, and only in that job's own staging folder (see partialDataDeletable, and SABnzbd's own job folder);
    // otherwise every file is left where it is. Published library files are never touched.
    async cancel(body) {
      requireEnabled()
      const job = await loadJob(body?.id)
      if (isUsenetJob(job)) {
        const outcome = usenet ? await usenet.cancel(job).catch((error) => { throw asTomifinError(error) }) : { filesDeleted: false, removed: false }
        await deleteJob(job.id)
        log(`Tomifin removed ${logName(job)} from SABnzbd (${outcome.filesDeleted ? 'partial download deleted' : 'files kept'})`)
        return { cancelled: true, filesDeleted: outcome.filesDeleted, downloaderRemoved: outcome.removed }
      }
      const torrent = await torrentFor(job)
      let filesDeleted = false
      if (torrent) {
        filesDeleted = job.recovered !== true && partialDataDeletable(torrent, config.destinations[job.destination], job.id)
        await client.remove(text(torrent.hash).toLowerCase(), filesDeleted)
      }
      await deleteJob(job.id)
      log(`Tomifin removed ${logName(job)} (${filesDeleted ? 'partial download deleted' : 'files kept'})`)
      return { cancelled: true, filesDeleted, torrentRemoved: Boolean(torrent) }
    },

    // Runs every few seconds: keeps both downloaders and the records in step (see reconcile) and starts publishing
    // finished Usenet downloads.
    async observe() {
      if (!config?.enabled || !client) return
      const { usenetJobs, snapshot } = await current()
      if (usenetReady()) await usenet.process(usenetJobs, snapshot, store)
    },

    start() {
      if (!config?.enabled || !client) return () => {}
      let running = false
      const timer = setInterval(() => {
        if (running) return
        running = true
        controller.observe().catch((error) => log(`Tomifin check failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false })
      }, intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
  return controller
}

// The agent's /v1/tomifin/* routes. Returns null for any other path. Every route but login needs the Jellyfin
// session token (body.session) of a Jellyfin administrator, checked with Jellyfin (recovery-agent/jellyfin.mjs).
export async function handleTomifinRequest(path, body, controller, auth) {
  const route = String(path || '').match(/^\/v1\/tomifin\/(login|logout|session|status|vpn|search|link|download|downloads|pause|resume|cancel)$/)
  if (!route) return null
  const action = route[1]
  try {
    if (action === 'login') return { status: 200, body: await auth.login(body) }
    if (action === 'logout') return { status: 200, body: await auth.logout(body?.session) }
    const user = await auth.verify(body?.session)
    if (action === 'session') return { status: 200, body: { user: { name: user.name } } }
    if (action === 'status') return { status: 200, body: controller.status() }
    if (action === 'vpn') return { status: 200, body: await controller.vpn() }
    if (action === 'search') return { status: 200, body: await controller.search(body) }
    if (action === 'link') return { status: 200, body: await controller.link(body) }
    if (action === 'download') return { status: 202, body: await controller.download(body) }
    if (action === 'downloads') return { status: 200, body: await controller.list() }
    return { status: 200, body: await controller[action](body) }
  } catch (error) {
    if (error instanceof TomifinError || error instanceof JellyfinAuthError) return { status: 400, body: { error: 'tomifin-error', code: error.code, message: error.message } }
    throw error
  }
}
