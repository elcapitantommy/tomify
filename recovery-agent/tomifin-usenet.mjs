// Tomifin's Usenet downloads: films and TV found on the Newznab indexers Recovery already uses, downloaded by the
// SABnzbd Recovery already uses, then published into the Family or Private Jellyfin library.
//
//   search   Newznab categories 2000 (Movies) / 5000 (TV); the browser only ever sees an opaque result id.
//   queue    the agent fetches the NZB itself (API key stays here), checks it (tomifin-links.mjs), writes the job
//            record, then uploads it to SABnzbd as job "tomifin-<job id>" in category tomifin-family/-private.
//   staging  SABnzbd downloads and unpacks in its own folders, outside both libraries, so nothing half-done is ever
//            in Jellyfin's tree.
//   publish  once SABnzbd reports the job Completed (unpacked and post-processed), the agent checks the folder and
//            publishes: Family through the Family importer (films and TV, family-import.mjs), Private as a verified
//            copy of its videos and subtitles. Doubtful downloads go to a hidden review folder with reason.json.
//   cleanup  SABnzbd's output is never deleted unless TOMIFY_TOMIFIN_USENET_CLEANUP=true and publication was verified.
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createSabnzbdClient, newznabDownloadUrl, nzbIndexDownloadUrl, searchNewznabVideo, searchNzbIndexVideo, validateCompletedPath } from './usenet.mjs'
import { createFamilyImporter, DEFAULT_TV_DIR, ffprobeReader } from './family-import.mjs'
import { PublishError, ensureIgnoredFolder, publishPrivateDownload, strictlyWithin } from './media-publish.mjs'
import { LinkError, createLinkFetcher, parseNzb } from './tomifin-links.mjs'

export const DEFAULT_SABNZBD_CATEGORIES = Object.freeze({ family: 'tomifin-family', private: 'tomifin-private' })
export const NEWZNAB_CATEGORIES = Object.freeze({ video: '2000,5000', movies: '2000', tv: '5000' })
export const UNCONFIRMED_KEEP_MS = 15 * 60_000
const MISSING_GRACE_MS = 15 * 60_000
// Publication that fails for a reason that may pass (a library or pool briefly unmounted, a disk error, SABnzbd's
// folder not there yet) is retried with growing gaps, up to every 30 minutes, for as long as it takes; only a
// definite problem with the download itself fails it or holds it for review.
const RETRY_MS = 30_000
const MAX_RETRY_MS = 30 * 60_000
export function publishRetryDelay(attempts) { return Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 16)) }
const CATEGORY = /^[a-z0-9][a-z0-9_.-]{0,63}$/i
const PRIVATE_REVIEW = '.tomifin-review'

function text(value) { return String(value ?? '').trim() }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function message(error) { return error instanceof Error ? error.message : String(error) }

export class TomifinUsenetError extends Error {
  constructor(code, text) { super(text); this.name = 'TomifinUsenetError'; this.code = code }
}

// Tomifin's Usenet settings: SABnzbd and its completed folder (needed to download any NZB, including an added link or
// upload), Recovery's search providers (NZBIndex, anonymous by default, and any Newznab indexers; needed only to
// search), plus Tomifin's own SABnzbd categories and publication choices. Usenet stays off (with a reason) without
// disturbing torrents; search can be off while added NZBs still work.
export function tomifinUsenetConfig(env = process.env, { indexers = [], nzbIndex = null, downloader = null, downloadRoot = null, tomifin = null } = {}) {
  const off = (problem) => ({ available: false, problem, search: { available: false, providers: [], problem } })
  if (!tomifin?.enabled) return off(tomifin?.problem || 'Tomifin Downloader is off.')
  if (!downloader) return off('SABnzbd is not configured (TOMIFY_SABNZBD_URL and TOMIFY_SABNZBD_API_KEY).')
  if (downloader.type !== 'sabnzbd') return off('Tomifin\'s Usenet downloads need SABnzbd; NZBGet is not supported.')
  if (!downloader.apiKey) return off('TOMIFY_SABNZBD_API_KEY is not set.')
  if (!downloadRoot || !isAbsolute(String(downloadRoot))) return off('Set TOMIFY_USENET_DOWNLOAD_DIR to SABnzbd\'s completed folder as the agent sees it.')
  const categories = {
    family: text(env.TOMIFY_TOMIFIN_SABNZBD_FAMILY_CATEGORY) || DEFAULT_SABNZBD_CATEGORIES.family,
    private: text(env.TOMIFY_TOMIFIN_SABNZBD_PRIVATE_CATEGORY) || DEFAULT_SABNZBD_CATEGORIES.private,
  }
  if (!CATEGORY.test(categories.family) || !CATEGORY.test(categories.private)) return off('The Tomifin SABnzbd categories must be simple names such as tomifin-family.')
  if (categories.family.toLowerCase() === categories.private.toLowerCase()) return off('Family and Private need different SABnzbd categories.')
  if ([categories.family, categories.private].some((category) => category.toLowerCase() === text(downloader.category).toLowerCase())) return off('Tomifin\'s SABnzbd categories must differ from Recovery\'s (TOMIFY_USENET_CATEGORY).')
  const publish = text(env.TOMIFY_TOMIFIN_USENET_PUBLISH || 'auto').toLowerCase()
  if (!['auto', 'copy'].includes(publish)) return off('TOMIFY_TOMIFIN_USENET_PUBLISH must be auto or copy.')
  const root = resolve(downloadRoot)
  for (const destination of Object.values(tomifin.destinations)) {
    if (strictlyWithin(root, destination.hostPath) || root === destination.hostPath || strictlyWithin(destination.hostPath, root)) return off('TOMIFY_USENET_DOWNLOAD_DIR must be outside the Family and Private libraries.')
  }
  const providers = [...(nzbIndex ? [nzbIndex.name] : []), ...indexers.map((indexer) => indexer.name)]
  const search = { available: providers.length > 0, providers, problem: providers.length ? null : 'No Usenet search provider is configured (NZBIndex or TOMIFY_NEWZNAB_INDEXERS_JSON); added NZB links and files still work.' }
  return {
    available: true, problem: null, search, indexers, nzbIndex: nzbIndex || null, sab: downloader, root, sabRoot: downloader.downloadRoot || null, categories, publish,
    cleanup: text(env.TOMIFY_TOMIFIN_USENET_CLEANUP).toLowerCase() === 'true',
    moviesDir: text(env.TOMIFIN_IMPORT_MOVIES_SUBDIR), tvDir: text(env.TOMIFIN_IMPORT_TV_SUBDIR) || DEFAULT_TV_DIR,
  }
}

// SABnzbd's "H:MM:SS" or "D:HH:MM:SS" time left, in seconds.
export function sabTimeLeft(value) {
  const parts = text(value).split(':').map(Number)
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null
  const [days, hours, minutes, seconds] = parts.length === 4 ? parts : [0, ...parts]
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds
}

const PASSWORD = /encrypt|password/i

// One SABnzbd queue slot as Tomifin's status (queued, downloading, paused or failed), with SABnzbd's own words kept.
export function sabQueueState(slot) {
  const status = text(slot?.status)
  const labels = (Array.isArray(slot?.labels) ? slot.labels : []).map(text)
  if (labels.some((label) => PASSWORD.test(label))) return { status: 'failed', code: 'password-protected', message: 'The download is password-protected; SABnzbd paused it.' }
  if (/^paused$/i.test(status)) return { status: 'paused', message: 'Paused' }
  if (/^(?:queued|propagating)$/i.test(status)) return { status: 'queued', message: /propagating/i.test(status) ? 'Waiting for the posts to propagate' : 'Queued in SABnzbd' }
  if (/^(?:grabbing|fetching)$/i.test(status)) return { status: 'downloading', message: 'Fetching the NZB details' }
  if (/^checking/i.test(status)) return { status: 'downloading', message: 'Checking' }
  return { status: 'downloading', message: null }
}

// One SABnzbd history slot: Completed (unpacked and post-processed), Failed (with SABnzbd's reason), or still being
// verified, repaired, unpacked or moved.
export function sabHistoryState(slot) {
  const status = text(slot?.status)
  const failure = text(slot?.fail_message)
  if (/^completed$/i.test(status) && !failure) return { status: 'completed' }
  if (/^failed$/i.test(status) || (/^completed$/i.test(status) && failure)) {
    return { status: 'failed', code: PASSWORD.test(failure) ? 'password-protected' : /unpack|extract|par2|repair|crc/i.test(failure) ? 'unpack-failed' : 'download-failed', message: cleanMessage(failure) || 'SABnzbd reported the download as failed.' }
  }
  const step = { extracting: 'Unpacking', verifying: 'Verifying', repairing: 'Repairing', moving: 'Moving', running: 'Running scripts', queued: 'Waiting to unpack', fetching: 'Fetching extra blocks' }[status.toLowerCase()] || 'Post-processing'
  return { status: 'post-processing', message: `${step} in SABnzbd` }
}

// SABnzbd messages can name files and folders; paths and links are taken out before they are shown.
function cleanMessage(value) { return text(value).replace(/https?:\/\/\S+/g, '[link]').replace(/(?:^|\s)\/[^\s'"]+/g, ' [path]').replace(/\s+/g, ' ').trim().slice(0, 240) }

function jobName(id) { return `tomifin-${id}` }
const SAB_NAME = /^tomifin-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\.\d{1,3})?$/i

export function createTomifinUsenet({ config, tomifin, stateRoot, sab = config?.available ? createSabnzbdClient(config.sab) : null, fetchImpl = fetch, fetchNzb = null, importer = null, publishPrivate = publishPrivateDownload, probe = ffprobeReader(), now = () => Date.now(), log = () => {}, stableMs = 5000 }) {
  const available = Boolean(config?.available && sab)
  const fetchLink = fetchNzb || createLinkFetcher({ trustedHosts: (config?.indexers || []).map((indexer) => { try { return new URL(indexer.url).host } catch { return '' } }) })
  const importing = new Set()
  let chain = Promise.resolve()
  let familyImporter = importer

  function familyImport() {
    familyImporter ??= createFamilyImporter({ library: tomifin.destinations.family.hostPath, moviesDir: config.moviesDir, tvDir: config.tvDir, stateDir: join(resolve(stateRoot), 'tomifin', 'family-import'), probe, stableMs, log: (entry) => log(`Tomifin Family import: ${JSON.stringify(entry)}`) })
    return familyImporter
  }

  function requireUsenet() { if (!available) throw new TomifinUsenetError('usenet-unavailable', config?.problem || 'Usenet downloads are not set up on the media server.') }

  function categoryFor(destinationId) { return config.categories[destinationId] }

  // Where SABnzbd says a job's files are, as the agent sees it, without touching the disk.
  function mappedPath(value) {
    const reported = text(value)
    if (!reported || !isAbsolute(reported)) return null
    let path = normalize(reported)
    if (config.sabRoot) {
      const sabRoot = resolve(config.sabRoot)
      if (path !== sabRoot && !path.startsWith(sabRoot + sep)) return null
      path = resolve(config.root, relative(sabRoot, path))
    }
    return strictlyWithin(path, config.root) ? path : null
  }

  async function writeReview(job, code, reason) {
    const destination = tomifin.destinations[job.destination]
    if (!destination) return
    const area = job.destination === 'family' ? join(destination.hostPath, '.review') : join(destination.hostPath, PRIVATE_REVIEW)
    const folder = join(area, job.destination === 'family' ? `usenet-${job.id}` : job.id)
    try {
      await ensureIgnoredFolder(area)
      await mkdir(folder, { mode: 0o775 }).catch((error) => { if (error?.code !== 'EEXIST') throw error })
      await writeFile(join(folder, 'reason.json'), `${JSON.stringify({ job: job.id, downloader: 'sabnzbd', destination: job.destination, name: text(job.title).slice(0, 300), result: 'review', code, reason, at: new Date(now()).toISOString() }, null, 2)}\n`, { flag: 'wx' }).catch((error) => { if (error?.code !== 'EEXIST') throw error })
    } catch (error) { log(`Tomifin could not write a review note for ${job.id}: ${message(error)}`) }
  }

  function find(snapshot, job) {
    if (!snapshot || snapshot.error) return null
    const matches = (slot, name) => (job.remoteId && text(slot.nzo_id) === job.remoteId) || SAB_NAME.exec(text(name))?.[1]?.toLowerCase() === job.id
    const queued = snapshot.queue.find((slot) => matches(slot, slot.filename))
    if (queued) return { where: 'queue', slot: queued }
    const done = snapshot.history.find((slot) => matches(slot, slot.name))
    return done ? { where: 'history', slot: done } : null
  }

  const backend = {
    get available() { return available },
    get searchAvailable() { return available && Boolean(config.search?.available) },
    status() {
      const problem = available ? null : (config?.problem || 'Usenet downloads are not set up on the media server.')
      return { available, problem, search: available ? { available: Boolean(config.search?.available), providers: config.search?.providers || [], problem: config.search?.problem || null } : { available: false, providers: [], problem } }
    },
    categoryFor,

    // NZBIndex and Newznab results for films and/or TV, searched at once, as plain entries; the controller gives them
    // ids. A provider that fails is named in failedNames; the others' results are kept. Throws only if all fail.
    async search(query, kind) {
      requireUsenet()
      if (!config.search?.available) throw new TomifinUsenetError('usenet-unavailable', config.search?.problem || 'No Usenet search provider is configured.')
      const searches = []
      // Newznab first, so a release both list keeps Newznab's entry (it has grabs and a details page).
      if (config.indexers.length) searches.push({ names: config.indexers.map((indexer) => indexer.name), run: searchNewznabVideo(config.indexers, query, NEWZNAB_CATEGORIES[kind] || NEWZNAB_CATEGORIES.video, { fetchImpl }) })
      if (config.nzbIndex) searches.push({ names: [config.nzbIndex.name], run: searchNzbIndexVideo(config.nzbIndex, query, { fetchImpl }).then((results) => ({ results, failedNames: [] })) })
      const settled = await Promise.allSettled(searches.map((entry) => entry.run))
      if (settled.every((entry) => entry.status === 'rejected')) throw settled[0].reason
      const failedNames = settled.flatMap((entry, index) => entry.status === 'rejected' ? searches[index].names : entry.value.failedNames || [])
      // Interleaved, so one provider's long list does not crowd out the others before the result limit.
      const batches = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value.results)
      const results = []
      for (let index = 0; batches.some((batch) => index < batch.length); index += 1) for (const batch of batches) if (index < batch.length) results.push(batch[index])
      return { results, failed: failedNames.length, failedNames }
    },

    // Fetches and checks the NZB of a search result. The download link carries the indexer's API key, so it is built
    // here from the configured indexer and never stored or shown.
    async prepare(result) {
      requireUsenet()
      const nzbIndex = result.provider === 'nzbindex' ? config.nzbIndex : null
      const indexer = nzbIndex || config.indexers.find((entry) => entry.id === result.indexerId)
      if (!indexer || (result.provider === 'nzbindex' && result.indexerId !== nzbIndex?.id)) throw new TomifinUsenetError('result-expired', 'That indexer is no longer configured. Search again.')
      let fetched
      try { fetched = await fetchLink(nzbIndex ? nzbIndexDownloadUrl(nzbIndex, result.collectionId) : newznabDownloadUrl(indexer, result.guid), { maxBytes: 32 * 1024 * 1024 }) }
      catch (error) { throw new TomifinUsenetError(error instanceof LinkError && error.code === 'auth-required' ? 'indexer-refused' : 'indexer-unavailable', `${indexer.name} could not supply the NZB${error instanceof LinkError ? `: ${error.message.replace(/^The link/, 'the link').replace(/\.$/, '')}` : ''}.`) }
      if (!fetched.bytes) throw new TomifinUsenetError('invalid-nzb', `${indexer.name} did not return an NZB file.`)
      try { return { bytes: fetched.bytes, nzb: parseNzb(fetched.bytes, { fallbackName: result.title }) } }
      catch (error) { if (error instanceof LinkError) throw new TomifinUsenetError(error.code, `${indexer.name} returned an NZB that cannot be used: ${error.message}`); throw error }
    },

    // SABnzbd must have both of Tomifin's categories, or a download would land in its default folder instead.
    async ensureCategories() {
      requireUsenet()
      let categories
      try { categories = (await sab.categories()).map((value) => value.toLowerCase()) } catch { throw new TomifinUsenetError('usenet-unavailable', 'SABnzbd could not be reached.') }
      const missing = Object.values(config.categories).filter((category) => !categories.includes(category.toLowerCase()))
      if (missing.length) throw new TomifinUsenetError('usenet-unavailable', `SABnzbd has no ${missing.join(' or ')} category yet. Add ${missing.length > 1 ? 'them' : 'it'} in SABnzbd (Config → Categories) as described in docs/TOMIFIN.md.`)
    },

    // Uploads the NZB. Throws with rejected: true when SABnzbd certainly did not take it; any other error leaves the
    // outcome unknown, and the caller keeps the record unconfirmed instead of submitting again.
    async submit(job, bytes) {
      requireUsenet()
      return sab.addFile(bytes, { name: jobName(job.id), category: job.category })
    },

    async snapshot() {
      if (!available) return null
      try {
        const [queue, ...histories] = await Promise.all([sab.queue(), ...Object.values(config.categories).map((category) => sab.history(category))])
        const categories = new Set(Object.values(config.categories).map((category) => category.toLowerCase()))
        return {
          queue: queue.slots.filter((slot) => categories.has(text(slot.cat).toLowerCase())),
          kbPerSec: queue.kbPerSec, history: histories.flat().filter((slot) => categories.has(text(slot.category).toLowerCase())),
        }
      } catch (error) { return { error: message(error), queue: [], history: [] } }
    },

    // Looks for a job by name after an unconfirmed upload.
    async locate(job) {
      const found = find(await backend.snapshot(), job)
      return found ? text(found.slot.nzo_id) : null
    },

    // Keeps records and SABnzbd in step: confirms or drops unconfirmed uploads, records SABnzbd jobs named
    // tomifin-<id> that lost their record, notices jobs that vanished, and records failures with a review note.
    async reconcile(jobs, snapshot, store) {
      if (!snapshot || snapshot.error) return
      const known = new Set(jobs.map((job) => job.id))
      for (const [where, slots] of [['queue', snapshot.queue], ['history', snapshot.history]]) {
        for (const slot of slots) {
          const id = SAB_NAME.exec(text(where === 'queue' ? slot.filename : slot.name))?.[1]?.toLowerCase()
          if (!id || known.has(id)) continue
          const category = text(where === 'queue' ? slot.cat : slot.category).toLowerCase()
          const destination = Object.keys(config.categories).find((key) => config.categories[key].toLowerCase() === category)
          if (!destination) continue
          const job = { id, version: 2, downloader: 'sabnzbd', createdAt: new Date(now()).toISOString(), destination, title: 'Usenet download', source: 'SABnzbd', size: null, category: config.categories[destination], remoteId: text(slot.nzo_id) || null, recovered: true }
          try { await store.saveJob(job); jobs.push(job); known.add(id); log(`Tomifin found SABnzbd job ${id} without a record and is tracking it again`) }
          catch (error) { log(`Tomifin could not record SABnzbd job ${id}: ${message(error)}`) }
        }
      }
      for (const job of [...jobs]) {
        const found = find(snapshot, job)
        if (job.unconfirmedSince) {
          if (found) {
            delete job.unconfirmedSince
            job.remoteId = text(found.slot.nzo_id) || null
            await store.saveJob(job).catch(() => {})
            log(`Tomifin confirmed Usenet job ${job.id} in SABnzbd`)
          } else if (now() - Date.parse(job.unconfirmedSince) > UNCONFIRMED_KEEP_MS) {
            try { await store.deleteJob(job.id); jobs.splice(jobs.indexOf(job), 1); log(`Tomifin dropped Usenet job ${job.id}: SABnzbd never showed it`) }
            catch (error) { log(`Tomifin could not drop an unconfirmed Usenet job: ${message(error)}`) }
          }
          continue
        }
        if (job.failure || ['published', 'already-imported', 'review'].includes(job.import?.state)) continue
        if (!found) {
          if (!job.missingSince) { job.missingSince = new Date(now()).toISOString(); await store.saveJob(job).catch(() => {}) }
          else if (now() - Date.parse(job.missingSince) > MISSING_GRACE_MS) {
            job.failure = { code: 'downloader-lost', reason: 'The download is no longer in SABnzbd.' }
            await store.saveJob(job).catch(() => {})
          }
          continue
        }
        if (job.missingSince) { delete job.missingSince; await store.saveJob(job).catch(() => {}) }
        if (!job.remoteId && found.slot.nzo_id) { job.remoteId = text(found.slot.nzo_id); await store.saveJob(job).catch(() => {}) }
        const state = found.where === 'queue' ? sabQueueState(found.slot) : sabHistoryState(found.slot)
        if (state.status === 'failed') {
          job.failure = { code: state.code, reason: state.message }
          await store.saveJob(job).catch(() => {})
          await writeReview(job, state.code, state.message)
          log(`Tomifin Usenet job ${job.id} failed in SABnzbd (${state.code})`)
        }
      }
    },

    // Starts publication of every job SABnzbd has finished (one at a time, in the background).
    process(jobs, snapshot, store) {
      if (!snapshot || snapshot.error) return
      for (const job of jobs) {
        if (job.unconfirmedSince || job.failure || importing.has(job.id) || ['published', 'already-imported', 'review', 'failed'].includes(job.import?.state)) continue
        const found = find(snapshot, job)
        if (found?.where !== 'history' || sabHistoryState(found.slot).status !== 'completed') continue
        if (job.import?.nextAttemptAt && Date.parse(job.import.nextAttemptAt) > now()) continue
        importing.add(job.id)
        chain = chain.then(() => backend.publish(job, found.slot, store)).catch((error) => log(`Tomifin Usenet publication failed: ${message(error)}`)).finally(() => importing.delete(job.id))
      }
      return chain
    },

    // Publishes one finished job. Only a Completed history slot for this job's own category and name is accepted,
    // and its folder must be strictly inside the Usenet download folder.
    async publish(job, slot, store) {
      const attempts = (job.import?.attempts || 0) + 1
      job.import = { state: 'importing', attempts, at: new Date(now()).toISOString() }
      await store.saveJob(job)
      const finish = async (state, extra = {}) => {
        job.import = { state, attempts, at: new Date(now()).toISOString(), ...extra }
        if (['published', 'already-imported'].includes(state)) job.completedAt = job.import.at
        await store.saveJob(job)
      }
      const review = async (code, reason) => { await finish('review', { code, reason }); await writeReview(job, code, reason); log(`Tomifin held Usenet job ${job.id} for review (${code})`) }
      try {
        if (text(slot.category).toLowerCase() !== text(job.category).toLowerCase()) return review('wrong-category', 'SABnzbd finished the download in another category.')
        const mapped = mappedPath(slot.storage)
        if (!mapped || !SAB_NAME.test(basename(mapped)) || SAB_NAME.exec(basename(mapped))[1].toLowerCase() !== job.id) return review('unsafe-path', 'SABnzbd reported a folder that is not this download\'s own folder inside the Usenet download folder.')
        let completed
        try { completed = await validateCompletedPath(slot.storage, config.root, config.sabRoot) }
        catch (error) { return error?.code === 'ENOENT' ? retry(new Error('The finished download folder is missing.')) : review('unsafe-path', 'SABnzbd reported a folder outside the Usenet download folder.') }
        const destination = tomifin.destinations[job.destination]
        if (job.destination === 'family') {
          const result = await familyImport().importDirectory({ key: `usenet-${job.id}`, name: job.title, root: completed, allowedRoot: config.root, mode: config.publish, maxBytes: tomifin.maxBytes })
          const outcome = result.result === 'unchanged' ? result.previous?.result : result.result
          if (['published', 'already-imported'].includes(outcome)) await finish(outcome, { published: (result.published || result.previous?.published || []).length })
          else if (outcome === 'review') await finish('review', { code: result.code || result.previous?.code || 'review', reason: result.reason || result.previous?.reason })
          else if (result.result === 'not-ready') return retry(new Error(result.reason))
          else await finish('failed', { code: result.code || 'import-failed', reason: result.reason || 'The Family importer could not publish it.' })
        } else {
          try {
            const result = await publishPrivate({ key: job.id, title: job.title, root: completed, allowedRoot: config.root, library: destination.hostPath, mode: config.publish, probe, maxBytes: tomifin.maxBytes, stableMs })
            await finish(result.result, { published: result.published.length })
          } catch (error) {
            if (!(error instanceof PublishError)) throw error
            if (error.retry) return retry(error)
            if (error.review) return review(error.code, error.message)
            await finish('failed', { code: error.code, reason: error.message })
          }
        }
        log(`Tomifin Usenet job ${job.id}: ${job.import.state}`)
        if (config.cleanup && ['published', 'already-imported'].includes(job.import.state) && text(slot.nzo_id)) {
          // Only after a verified publication, and only because the setting says so: SABnzbd removes its own folder.
          try { await sab.deleteHistory(text(slot.nzo_id), true); job.cleanedUp = true; await store.saveJob(job); log(`Tomifin removed SABnzbd's copy of Usenet job ${job.id} after publishing it`) }
          catch (error) { log(`Tomifin could not clean up Usenet job ${job.id} in SABnzbd: ${message(error)}`) }
        }
      } catch (error) {
        return retry(error)
      }
      async function retry(error) {
        await finish('pending', { reason: cleanMessage(message(error)) || 'Publication failed; trying again.', nextAttemptAt: new Date(now() + publishRetryDelay(attempts)).toISOString() })
      }
    },

    view(job, snapshot, destination) {
      const base = {
        id: job.id, name: job.title, destination: job.destination, destinationLabel: destination?.label || job.destination, downloader: 'sabnzbd', downloaderLabel: 'SABnzbd', type: 'usenet',
        progress: 0, downloadSpeed: null, uploadSpeed: null, downloaded: null, size: job.size || null, eta: null, seeds: null, peers: null,
        source: job.source || null, createdAt: job.createdAt, canPause: false, canResume: false, keepsFilesOnCancel: true,
      }
      const label = destination?.label || job.destination
      if (!available) return { ...base, status: 'failed', message: 'Usenet downloads are not set up on the media server.' }
      if (['published', 'already-imported'].includes(job.import?.state)) return { ...base, status: 'completed', message: job.import.state === 'already-imported' ? `Already in ${label}` : `In the ${label} library`, progress: 100, downloaded: job.size || null }
      if (job.import?.state === 'review') return { ...base, status: 'failed', message: `Held for review: ${cleanMessage(job.import.reason) || job.import.code}`, progress: 100 }
      if (job.import?.state === 'failed') return { ...base, status: 'failed', message: cleanMessage(job.import.reason) || 'Publication failed.', progress: 100 }
      if (job.failure) return { ...base, status: 'failed', message: job.failure.reason || 'The download failed.', keepsFilesOnCancel: job.recovered === true }
      const found = find(snapshot, job)
      if (!found) {
        if (job.unconfirmedSince) return { ...base, status: 'queued', message: 'Waiting for SABnzbd to confirm' }
        return { ...base, status: 'queued', message: snapshot?.error ? 'SABnzbd could not be reached' : 'Waiting for SABnzbd' }
      }
      if (found.where === 'queue') {
        const slot = found.slot
        const state = sabQueueState(slot)
        const total = number(slot.mb)
        const left = number(slot.mbleft)
        const size = total !== null && total > 0 ? Math.round(total * 1024 * 1024) : base.size
        const downloading = state.status === 'downloading'
        const onlyDownloading = snapshot.queue.filter((entry) => sabQueueState(entry).status === 'downloading').length === 1
        return {
          ...base, ...state, code: undefined, progress: Math.max(0, Math.min(100, number(slot.percentage) || 0)), size,
          downloaded: total !== null && left !== null ? Math.max(0, Math.round((total - left) * 1024 * 1024)) : null,
          downloadSpeed: downloading && onlyDownloading && snapshot.kbPerSec !== null ? Math.round(snapshot.kbPerSec * 1024) : null,
          eta: downloading ? sabTimeLeft(slot.timeleft) : null,
          canPause: ['queued', 'downloading'].includes(state.status), canResume: state.status === 'paused',
          // SABnzbd deletes only this job's own unfinished folder when it is cancelled.
          keepsFilesOnCancel: job.recovered === true,
        }
      }
      const state = sabHistoryState(found.slot)
      const bytes = number(found.slot.bytes)
      const size = bytes !== null && bytes > 0 ? bytes : base.size
      if (state.status === 'post-processing') return { ...base, status: 'downloading', message: state.message, progress: 100, size, downloaded: size }
      if (state.status === 'failed') return { ...base, status: 'failed', message: state.message, size, keepsFilesOnCancel: job.recovered === true }
      return { ...base, status: 'downloading', message: job.import?.state === 'pending' && job.import.reason ? `Waiting to publish to ${label}: ${cleanMessage(job.import.reason)}` : `Publishing to ${label}`, progress: 100, size, downloaded: size }
    },

    async pause(job) {
      requireUsenet()
      const found = find(await backend.snapshot(), job)
      if (found?.where !== 'queue') throw new TomifinUsenetError('not-in-sabnzbd', 'Only a download still in SABnzbd\'s queue can be paused.')
      await sab.pause(text(found.slot.nzo_id))
    },
    async resume(job) {
      requireUsenet()
      const found = find(await backend.snapshot(), job)
      if (found?.where !== 'queue') throw new TomifinUsenetError('not-in-sabnzbd', 'Only a download still in SABnzbd\'s queue can be resumed.')
      if (sabQueueState(found.slot).code === 'password-protected') throw new TomifinUsenetError('password-protected', 'This download is password-protected and cannot be resumed.')
      await sab.resume(text(found.slot.nzo_id))
    },

    // Takes the job out of SABnzbd. Unfinished data is deleted only in that job's own SABnzbd folder; a finished
    // job's history entry is removed with its files kept; library files are never touched.
    async cancel(job) {
      if (importing.has(job.id) || job.import?.state === 'importing') throw new TomifinUsenetError('busy', 'Tomifin is publishing this download right now. Try again when it has finished.')
      if (!available) return { filesDeleted: false, removed: false }
      const snapshot = await backend.snapshot()
      if (snapshot?.error) throw new TomifinUsenetError('usenet-unavailable', 'SABnzbd could not be reached, so the download was not cancelled.')
      const found = find(snapshot, job)
      if (!found) return { filesDeleted: false, removed: false }
      const id = text(found.slot.nzo_id)
      if (found.where === 'queue') {
        const deleteFiles = job.recovered !== true
        await sab.deleteQueued(id, deleteFiles)
        return { filesDeleted: deleteFiles, removed: true }
      }
      const state = sabHistoryState(found.slot)
      if (state.status === 'post-processing') throw new TomifinUsenetError('busy', 'SABnzbd is unpacking this download. Cancel it once that has finished.')
      // A failed job's own folder may be deleted; a completed one's never is (it may be the published copy's source).
      const mapped = mappedPath(found.slot.storage)
      const own = Boolean(mapped && SAB_NAME.exec(basename(mapped).replace(/^_(?:FAILED|UNPACK)_/, ''))?.[1]?.toLowerCase() === job.id)
      const deleteFiles = state.status === 'failed' && own && job.recovered !== true && !job.import
      await sab.deleteHistory(id, deleteFiles)
      return { filesDeleted: deleteFiles, removed: true }
    },
  }
  return backend
}
