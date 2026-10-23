// Tomifin Family importer. When qBittorrent finishes a Family torrent (category tomifin-family, saved under the
// hidden staging folder <library>/.downloads), this publishes the film into the Jellyfin library as
// <library>/Title (Year)/Title (Year).ext, with its subtitles, as hardlinks: qBittorrent's own files are never moved,
// renamed or deleted, so the torrent keeps seeding.
//
// Everything about a torrent (its name, file names, the hash a hook passes) is untrusted. Nothing is published unless
// every check passes; anything doubtful goes to <library>/.review/<hash>/ (hardlinks plus reason.json) instead, and
// nothing that already exists is ever overwritten. Run with --dry-run to see what would happen without writing.
//
//   node family-import.mjs --hash <info hash> [--dry-run]   import one torrent
//   node family-import.mjs --queue [--dry-run]              import every hash the qBittorrent hook queued
//   node family-import.mjs --scan [--dry-run]               import every finished Family torrent not yet handled
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, realpathSync } from 'node:fs'
import { link, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STAGING = '.downloads'
export const REVIEW = '.review'
export const PUBLISHING = '.publishing'
// A films folder inside the library, such as Movies; never hidden, never a path.
const MOVIES_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
export const QUEUE = '.tomifin-import-queue'
export const FAMILY_CATEGORY = 'tomifin-family'
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg'])
const SUBTITLE = new Set(['.srt'])
const PARTIAL = /\.(?:!qb|part|parts|crdownload|tmp)$/i
const SAMPLE = /(?:^|[^a-z])(?:sample|trailer|preview|teaser)(?:[^a-z]|$)/i
const COMPLETE_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP'])
// The main film must be this long according to ffprobe, so a trailer or sample is never published as the film.
const MIN_DURATION_SECONDS = 20 * 60
// Another video at least this share of the largest one's size makes the main file ambiguous (two parts, two cuts).
const RIVAL_SHARE = 0.4

export class ImportError extends Error {
  constructor(code, message, { review = false, retry = false } = {}) { super(message); this.name = 'ImportError'; this.code = code; this.review = review; this.retry = retry }
}

function text(value) { return String(value ?? '').trim() }
function within(child, parent) { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }
function strictlyWithin(child, parent) { return child !== parent && within(child, parent) }

// ---------------------------------------------------------------------------------------------------------------
// Names

// Words in release names that are never part of a film's title. Matching is on whole words, case-insensitive.
const RELEASE_TAGS = new Set(`
  2160p 1080p 1080i 720p 576p 480p 4k uhd hd fhd sd
  bluray blu ray bdrip brrip bdremux remux web dl webdl webrip web-dl web-rip hdrip hdtv dvdrip dvdscr dvd dvd5 dvd9 hddvd
  x264 x265 h264 h265 hevc avc xvid divx av1 vp9 10bit 8bit hi10p
  aac ac3 eac3 dd ddp dts dts-hd hdma ma truehd atmos flac mp3 opus lpcm
  hdr hdr10 hdr10plus dv dovi sdr imax
  proper repack rerip extended unrated uncut remastered theatrical directors cut dc limited internal multi dual audio dubbed subbed subs
  yify yts yts.mx yts.am yts.lt yts.ag rarbg ettv eztv evo sparks fgt ntb amzn nf dsnp hmax atvp
`.trim().split(/\s+/))
const YEAR = /^(?:19[0-9]{2}|20[0-9]{2})$/
const EPISODE = /\b(?:s\d{1,2}\s?e\d{1,3}|\d{1,2}x\d{2,3}|season\s?\d+|episode\s?\d+|complete series)\b/i

function words(name) {
  return text(name)
    .replace(/\.(?:mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i, '')
    // Audio channels ("5.1", "AAC2.0") become one tag, so their digits never look like part of the title.
    .replace(/([0-9])\.([0-9])(?![0-9])/g, '$1$2ch')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*|-\s+/g, ' - ')
    .split(/\s+/)
    .filter(Boolean)
}

function isTag(word) {
  const value = word.toLowerCase().replace(/^-+|-+$/g, '')
  return RELEASE_TAGS.has(value) || /^\d{3,4}[pi]$/.test(value) || /^\d{2}ch$/.test(value) || /^\d+bit$/.test(value) || /^[hx]\.?26[45]$/.test(value)
    || /^(?:aac|ac3|eac3|ddp?|dts|truehd|flac|opus|lpcm)\d*(?:ch)?$/.test(value) || /^[a-z0-9]+-[a-z0-9]+$/.test(value) && value.split('-').some((part) => RELEASE_TAGS.has(part) || /^[hx]26[45]$/.test(part))
}

// A Jellyfin-style "Title (Year)" from a release name such as "Toy.Story.2.1999.1080p.BluRay.x264-YIFY" or
// "Toy Story 2 (1999) [1080p] [YTS.MX]". Returns null when the name does not say so unambiguously: no year, a title
// that would be empty or contain release tags, a TV episode, or two different readings.
export function parseFilmName(name) {
  const raw = text(name)
  if (!raw || EPISODE.test(raw.replace(/[._]/g, ' '))) return null
  const list = words(raw)
  // The year is the last one that is followed only by release tags, a release group, or nothing.
  const candidates = []
  for (let index = 1; index < list.length; index += 1) {
    if (!YEAR.test(list[index])) continue
    const rest = list.slice(index + 1)
    const firstOther = rest.findIndex((word) => word !== '-' && !isTag(word))
    // After the year: tags, then at most a "- Group" suffix or one trailing group word after a tag.
    const tail = firstOther === -1 ? [] : rest.slice(firstOther)
    const groupOnly = tail.length === 0 || (tail.length === 1 && (rest[firstOther - 1] === '-' || firstOther > 0)) || (tail.length === 2 && tail[0] === '-')
    if (groupOnly) candidates.push(index)
  }
  if (!candidates.length) return null
  const yearIndex = candidates[candidates.length - 1]
  const titleWords = list.slice(0, yearIndex).filter((word) => word !== '-')
  if (!titleWords.length || titleWords.some(isTag)) return null
  const year = Number(list[yearIndex])
  if (year < 1888 || year > new Date().getUTCFullYear() + 1) return null
  const title = titleWords.join(' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '')
  if (!title || title.length > 150 || /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(title)) return null
  return { title, year, name: `${title} (${year})` }
}

// The film named by the torrent and by its main file. They must agree when both name one; otherwise it is ambiguous.
export function filmIdentity(torrentName, mainFileName) {
  const fromTorrent = parseFilmName(torrentName)
  const fromFile = parseFilmName(basename(mainFileName))
  if (fromTorrent && fromFile && (fromTorrent.year !== fromFile.year || fromTorrent.title.toLowerCase() !== fromFile.title.toLowerCase())) {
    return { identity: null, reason: `the torrent name says "${fromTorrent.name}" but the video file says "${fromFile.name}"` }
  }
  const identity = fromTorrent || fromFile
  return identity ? { identity, reason: null } : { identity: null, reason: 'the title and year could not be read from the torrent or file name' }
}

// Languages a subtitle file name can name. Two-letter codes count only as the last part of the name ("film.en.srt"),
// since short words such as "it" also occur in titles.
const LANGUAGES = {
  en: ['english', 'eng'], fr: ['french', 'francais', 'fre', 'fra'], es: ['spanish', 'espanol', 'spa'], de: ['german', 'deutsch', 'ger', 'deu'],
  it: ['italian', 'italiano', 'ita'], pt: ['portuguese', 'por'], nl: ['dutch', 'nederlands', 'dut', 'nld'], sv: ['swedish', 'swe'],
  no: ['norwegian', 'nor'], da: ['danish', 'dan'], fi: ['finnish', 'fin'], pl: ['polish', 'pol'], ru: ['russian', 'rus'],
  ja: ['japanese', 'jpn'], zh: ['chinese', 'chi', 'zho'], ko: ['korean', 'kor'], ar: ['arabic', 'ara'], he: ['hebrew', 'heb'],
  tr: ['turkish', 'tur'], el: ['greek', 'gre', 'ell'], cs: ['czech', 'cze', 'ces'], hu: ['hungarian', 'hun'], ro: ['romanian', 'rum', 'ron'],
}
const LANGUAGE_WORDS = new Map(Object.entries(LANGUAGES).flatMap(([code, names]) => names.map((name) => [name, code])))

// The language and flags of one subtitle file, from its own name and folder, ignoring words of the film's name.
export function subtitleLanguage(relativePath, videoName) {
  const ignore = new Set(words(videoName).map((word) => word.toLowerCase()))
  const name = basename(relativePath).replace(/\.srt$/i, '')
  const parts = [...words(dirname(relativePath) === '.' ? '' : dirname(relativePath)), ...words(name)].map((word) => word.toLowerCase().replace(/^\d+_/, ''))
  const found = new Set()
  for (const word of parts) if (!ignore.has(word) && LANGUAGE_WORDS.has(word)) found.add(LANGUAGE_WORDS.get(word))
  const last = name.split('.').pop().toLowerCase()
  if (name.includes('.') && /^[a-z]{2}$/.test(last) && Object.hasOwn(LANGUAGES, last)) found.add(last)
  const flags = []
  if (parts.includes('forced')) flags.push('forced')
  if (parts.some((word) => ['sdh', 'hi', 'cc'].includes(word))) flags.push('sdh')
  return { language: found.size === 1 ? [...found][0] : null, flags }
}

// ---------------------------------------------------------------------------------------------------------------
// Files

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function ffprobeReader(ffprobe = 'ffprobe') {
  return (path) => new Promise((resolvePromise) => {
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', '--', path], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolvePromise({ ok: false, reason: error.code === 'ENOENT' ? 'ffprobe is not installed' : 'ffprobe could not read it' }); return }
      try {
        const data = JSON.parse(stdout)
        const video = (data.streams || []).some((stream) => stream.codec_type === 'video')
        const duration = Number(data.format?.duration)
        resolvePromise(video ? { ok: true, duration: Number.isFinite(duration) ? duration : null } : { ok: false, reason: 'ffprobe found no video stream' })
      } catch { resolvePromise({ ok: false, reason: 'ffprobe output was not readable' }) }
    })
  })
}

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

// ---------------------------------------------------------------------------------------------------------------
// The importer

export function createFamilyImporter({ library, moviesDir = '', stateDir, qbittorrent, probe = ffprobeReader(), log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`), stableMs = 5000, queueRetries = 6, queueRetryMs = 10_000, dryRun = false, now = () => new Date() }) {
  if (!isAbsolute(text(library))) throw new Error('The Family library must be an absolute path.')
  if (text(moviesDir) && !MOVIES_DIR.test(text(moviesDir))) throw new Error('The films folder must be one plain folder name inside the Family library.')
  const paths = {}

  async function roots() {
    if (paths.library) return paths
    paths.library = await realpath(library)
    paths.staging = await realpath(join(paths.library, STAGING)).catch(() => { throw new ImportError('no-staging', `${join(library, STAGING)} does not exist.`) })
    if (!strictlyWithin(paths.staging, paths.library)) throw new ImportError('bad-staging', 'The staging folder must be inside the Family library.')
    paths.review = join(paths.library, REVIEW)
    paths.movies = paths.library
    if (text(moviesDir)) {
      paths.movies = await realpath(join(paths.library, text(moviesDir))).catch(() => { throw new ImportError('no-movies', `${join(library, text(moviesDir))} does not exist.`) })
      if (!strictlyWithin(paths.movies, paths.library)) throw new ImportError('bad-movies', 'The films folder must be inside the Family library.')
    }
    paths.publishing = join(paths.library, PUBLISHING)
    return paths
  }

  function statePath(hash) { return join(stateDir, `${hash}.json`) }
  async function readState(hash) { try { return JSON.parse(await readFile(statePath(hash), 'utf8')) } catch { return null } }
  async function writeState(hash, value) {
    if (dryRun) return
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${statePath(hash)}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, statePath(hash))
  }

  async function ensureIgnoredFolder(path) {
    if (dryRun) return
    await mkdir(path, { recursive: true, mode: 0o2775 })
    await writeFile(join(path, '.ignore'), '', { flag: 'a' })
  }

  // Resolves one torrent file to its real path, and refuses anything that is, or passes through, a link out of the
  // staging folder.
  async function sourceFile(root, relativePath) {
    const relativeName = text(relativePath)
    if (!relativeName || isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) throw new ImportError('unsafe-path', `Unsafe file name in the torrent: ${JSON.stringify(relativeName).slice(0, 200)}`, { review: true })
    const joined = resolve(root, relativeName)
    let real
    try { real = await realpath(joined) } catch { throw new ImportError('missing', `A file of the torrent is missing: ${relativeName.slice(0, 200)}`, { retry: true }) }
    if (!strictlyWithin(real, paths.staging) || real !== joined) throw new ImportError('unsafe-path', `A file of the torrent resolves outside the staging folder: ${relativeName.slice(0, 200)}`, { review: true })
    const info = await lstat(real)
    if (!info.isFile()) throw new ImportError('unsafe-path', `Not a regular file: ${relativeName.slice(0, 200)}`, { review: true })
    return { relative: relativeName, path: real, info }
  }

  // Checks that a file is complete and not changing: the size qBittorrent expects, not empty, not a partial file,
  // and the same size and modification time a few seconds apart.
  async function stable(file, expectedSize) {
    if (PARTIAL.test(file.path)) throw new ImportError('incomplete', `Still a partial file: ${file.relative.slice(0, 200)}`, { retry: true })
    if (file.info.size === 0) throw new ImportError('empty', `Empty file: ${file.relative.slice(0, 200)}`, { review: true })
    if (expectedSize !== null && file.info.size !== expectedSize) throw new ImportError('incomplete', `${file.relative.slice(0, 200)} is ${file.info.size} bytes, qBittorrent expects ${expectedSize}`, { retry: true })
    await delay(stableMs)
    const again = await lstat(file.path)
    if (again.size !== file.info.size || again.mtimeMs !== file.info.mtimeMs || again.ino !== file.info.ino) throw new ImportError('unstable', `${file.relative.slice(0, 200)} is still changing`, { retry: true })
  }

  // Works out what to publish, without writing anything.
  async function plan(torrent, files) {
    await roots()
    if (text(torrent.category) !== FAMILY_CATEGORY) throw new ImportError('not-family', 'Not a Tomifin Family torrent.')
    if (!(Number(torrent.progress) >= 1) || Number(torrent.amount_left) > 0 || !COMPLETE_STATES.has(text(torrent.state))) throw new ImportError('not-complete', `qBittorrent does not report the torrent as complete (state ${text(torrent.state) || 'unknown'}).`, { retry: true })
    const savePath = text(torrent.save_path)
    let root
    try { root = await realpath(savePath) } catch { throw new ImportError('missing', 'The torrent\'s save folder is missing.', { retry: true }) }
    if (!within(root, paths.staging) || root !== resolve(savePath)) throw new ImportError('unsafe-path', `The torrent is saved outside ${paths.staging}.`, { review: true })

    const wanted = (Array.isArray(files) ? files : []).filter((file) => Number(file.priority) !== 0)
    if (!wanted.length) throw new ImportError('no-files', 'qBittorrent lists no files for the torrent.', { retry: true })
    if (wanted.some((file) => Number(file.progress) < 1)) throw new ImportError('incomplete', 'qBittorrent has not finished every file.', { retry: true })

    const videos = []
    const subtitles = []
    let ignored = 0
    for (const entry of wanted) {
      const name = text(entry.name)
      const extension = extname(name).toLowerCase()
      const isVideo = VIDEO.has(extension)
      const isSubtitle = SUBTITLE.has(extension)
      // Samples, artwork, .txt/.nfo/.url adverts and everything else are left out.
      if ((!isVideo && !isSubtitle) || SAMPLE.test(name.replace(/\.[^.]+$/, ''))) { ignored += 1; continue }
      const file = await sourceFile(root, name)
      ;(isVideo ? videos : subtitles).push({ ...file, expectedSize: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null })
    }
    if (!videos.length) throw new ImportError('no-video', 'The torrent has no video file to publish.', { review: true })
    videos.sort((a, b) => b.info.size - a.info.size)
    const [main, rival] = videos
    if (rival && rival.info.size >= main.info.size * RIVAL_SHARE) throw new ImportError('ambiguous-video', `More than one large video file (${basename(main.relative)}, ${basename(rival.relative)}): which is the film is not clear.`, { review: true })

    for (const file of [main, ...subtitles]) await stable(file, file.expectedSize)
    const probed = await probe(main.path)
    if (!probed.ok) throw new ImportError(probed.reason === 'ffprobe is not installed' ? 'no-ffprobe' : 'unreadable', `${basename(main.relative)}: ${probed.reason}`, { review: probed.reason !== 'ffprobe is not installed', retry: probed.reason === 'ffprobe is not installed' })
    if (probed.duration !== null && probed.duration < MIN_DURATION_SECONDS) throw new ImportError('too-short', `${basename(main.relative)} is only ${Math.round(probed.duration / 60)} minutes long: not a film.`, { review: true })

    const { identity, reason } = filmIdentity(torrent.name, main.relative)
    if (!identity) throw new ImportError('ambiguous-name', `Not published: ${reason}.`, { review: true })

    const extension = extname(main.relative).toLowerCase()
    const outputs = [{ source: main, name: `${identity.name}${extension}`, kind: 'video' }]
    const taken = new Set(outputs.map((output) => output.name.toLowerCase()))
    const skipped = []
    // Biggest subtitle first, so with several of a language the fullest one gets the name.
    for (const subtitle of [...subtitles].sort((a, b) => b.info.size - a.info.size)) {
      const { language, flags } = subtitleLanguage(subtitle.relative, basename(main.relative))
      const name = `${identity.name}${language ? `.${language}` : ''}${flags.map((flag) => `.${flag}`).join('')}.srt`
      if (taken.has(name.toLowerCase())) { skipped.push(subtitle.relative); continue }
      taken.add(name.toLowerCase())
      outputs.push({ source: subtitle, name, kind: 'subtitle' })
    }
    return { identity, outputs, ignored, skippedSubtitles: skipped, main }
  }

  async function sameFilesystem(path) {
    const [staging, target] = await Promise.all([stat(paths.staging), stat(path)])
    if (staging.dev !== target.dev) throw new ImportError('cross-device', `${path} is on a different filesystem from the staging folder, so it cannot be hardlinked.`)
  }

  // Hardlinks the torrent's files into <library>/.review/<hash>/ with the reason, so nothing is lost or guessed.
  async function sendToReview(hash, torrent, error, details = {}) {
    const folder = join(paths.review, hash)
    const entry = { hash, name: text(torrent?.name).slice(0, 300), result: 'review', reason: error.message, ...details }
    if (dryRun) { log({ ...entry, dryRun: true }); return entry }
    await ensureIgnoredFolder(paths.review)
    const exists = await lstat(folder).then(() => true, () => false)
    if (!exists) {
      await mkdir(folder, { mode: 0o2775 })
      for (const file of details.files || []) {
        const target = join(folder, basename(file))
        await link(file, target).catch((failure) => log({ hash, result: 'review-link-failed', file: basename(file), reason: failure.code || failure.message }))
      }
      await writeFile(join(folder, 'reason.json'), `${JSON.stringify({ ...entry, at: now().toISOString() }, null, 2)}\n`, { flag: 'wx' })
    }
    log(entry)
    return entry
  }

  // Is this destination already the same film? Same inode, or same content, for the video.
  async function existingMatch(destination, outputs) {
    const video = outputs[0]
    const target = join(destination, video.name)
    const existing = await lstat(target).catch(() => null)
    if (existing?.isFile() && existing.ino === video.source.info.ino && existing.dev === video.source.info.dev) return 'same'
    if (existing?.isFile() && existing.size === video.source.info.size && await sha256(target) === await sha256(video.source.path)) return 'same'
    // A video under another name in the folder may also be this film (published by hand, say).
    for (const name of await readdir(destination).catch(() => [])) {
      const info = await lstat(join(destination, name)).catch(() => null)
      if (info?.isFile() && info.ino === video.source.info.ino && info.dev === video.source.info.dev) return 'same'
    }
    return existing ? 'different' : 'other'
  }

  async function importTorrent(hashValue) {
    const hash = text(hashValue).toLowerCase()
    if (!HASH.test(hash)) throw new ImportError('bad-hash', 'Not a torrent info hash.')
    await roots()
    const previous = await readState(hash)
    if (previous && ['published', 'already-imported'].includes(previous.result)) {
      const intact = await Promise.all((previous.published || []).map(async (path) => Boolean(await lstat(path).catch(() => null))))
      if (intact.every(Boolean)) { log({ hash, name: previous.name, result: 'unchanged', reason: `already ${previous.result}` }); return { result: 'unchanged', previous } }
    }
    if (previous?.result === 'review') { log({ hash, name: previous.name, result: 'unchanged', reason: 'waiting for review' }); return { result: 'unchanged', previous } }

    const torrent = await qbittorrent.torrent(hash)
    if (!torrent) throw new ImportError('not-in-qbittorrent', 'qBittorrent does not know this torrent.')
    let planned
    try {
      planned = await plan(torrent, await qbittorrent.files(hash))
    } catch (error) {
      if (!(error instanceof ImportError)) throw error
      if (error.review) {
        const entry = await sendToReview(hash, torrent, error, { files: await reviewFiles(torrent).catch(() => []) })
        await writeState(hash, { ...entry, at: now().toISOString() })
        return entry
      }
      log({ hash, name: text(torrent.name).slice(0, 300), result: error.retry ? 'not-ready' : 'skipped', reason: error.message })
      if (!error.retry && !dryRun && error.code !== 'not-family') await writeState(hash, { hash, name: text(torrent.name).slice(0, 300), result: 'skipped', reason: error.message, at: now().toISOString() })
      return { hash, result: error.retry ? 'not-ready' : 'skipped', reason: error.message }
    }

    const { identity, outputs } = planned
    const destination = join(paths.movies, identity.name)
    const base = { hash, name: text(torrent.name).slice(0, 300), title: identity.title, year: identity.year }
    await sameFilesystem(paths.movies)

    const exists = await lstat(destination).then(() => true, () => false)
    if (exists) {
      const match = await existingMatch(destination, outputs)
      if (match === 'same') {
        const entry = { ...base, result: 'already-imported', published: [destination] }
        log({ ...entry, dryRun: dryRun || undefined })
        await writeState(hash, { ...entry, sources: sources(outputs), at: now().toISOString() })
        return entry
      }
      const error = new ImportError('conflict', match === 'different' ? `${destination} already has a different ${outputs[0].name}; it was not overwritten.` : `${destination} already exists with other contents; it was not changed.`)
      const entry = await sendToReview(hash, torrent, error, { ...base, files: outputs.map((output) => output.source.path) })
      await writeState(hash, { ...entry, at: now().toISOString() })
      return entry
    }

    const publishedPaths = outputs.map((output) => join(destination, output.name))
    if (dryRun) {
      const entry = { ...base, result: 'would-publish', published: publishedPaths, ignoredFiles: planned.ignored, skippedSubtitles: planned.skippedSubtitles }
      log({ ...entry, dryRun: true })
      return entry
    }

    // Built in a hidden, ignored folder and renamed into place in one step, so Jellyfin never sees half a film.
    await ensureIgnoredFolder(paths.publishing)
    const work = join(paths.publishing, `${hash}-${randomUUID()}`)
    const building = join(work, identity.name)
    await mkdir(building, { recursive: true, mode: 0o2775 })
    try {
      for (const output of outputs) {
        const target = join(building, output.name)
        await link(output.source.path, target)
        const [made, source] = await Promise.all([lstat(target), lstat(output.source.path)])
        if (made.ino !== source.ino || made.dev !== source.dev || source.nlink < 2) throw new ImportError('link-failed', `The hardlink for ${output.name} did not take.`)
      }
      // rename() of a folder onto an existing, non-empty one fails, so a film published meanwhile is never replaced.
      await rename(building, destination)
    } catch (error) {
      for (const output of outputs) await unlink(join(building, output.name)).catch(() => {})
      await rmdir(building).catch(() => {})
      await rmdir(work).catch(() => {})
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
        const entry = await sendToReview(hash, torrent, new ImportError('conflict', `${destination} appeared while publishing; it was not changed.`), { ...base, files: outputs.map((output) => output.source.path) })
        await writeState(hash, { ...entry, at: now().toISOString() })
        return entry
      }
      throw error
    }
    await rmdir(work).catch(() => {})
    const entry = { ...base, result: 'published', published: publishedPaths, ignoredFiles: planned.ignored, skippedSubtitles: planned.skippedSubtitles.length ? planned.skippedSubtitles : undefined }
    log(entry)
    await writeState(hash, { ...entry, sources: sources(outputs), at: now().toISOString() })
    return entry
  }

  function sources(outputs) {
    return outputs.map((output) => ({ path: output.source.path, dev: output.source.info.dev, ino: output.source.info.ino, size: output.source.info.size, published: output.name }))
  }

  // The torrent's videos and subtitles that are safely inside staging, for hardlinking into review.
  async function reviewFiles(torrent) {
    const root = await realpath(text(torrent.save_path))
    if (!within(root, paths.staging)) return []
    const found = []
    for (const entry of await qbittorrent.files(text(torrent.hash).toLowerCase())) {
      const extension = extname(text(entry.name)).toLowerCase()
      if (!VIDEO.has(extension) && !SUBTITLE.has(extension)) continue
      try { found.push((await sourceFile(root, entry.name)).path) } catch { /* Left out of review. */ }
    }
    return found
  }

  // Hashes queued by the qBittorrent hook. A torrent that is not ready yet (qBittorrent can still be moving it out of
  // its temporary folder when the hook fires) is retried a few times in the same run. Each entry is then removed,
  // whatever the outcome; one still not ready is picked up again by --scan. A queue that cannot be read or emptied is
  // an error, never silently skipped: the path unit would otherwise start the importer again and again.
  async function drainQueue() {
    await roots()
    const queue = join(paths.staging, QUEUE)
    const results = []
    let names
    try { names = await readdir(queue) } catch (error) {
      if (error?.code === 'ENOENT') return results
      throw new Error(`The import queue ${queue} cannot be read: ${error?.code || error}`)
    }
    const remove = async (path) => {
      if (dryRun) return
      try { await unlink(path) } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error(`The queue entry ${path} cannot be removed: ${error?.code || error}`)
      }
    }
    for (const name of names) {
      const path = join(queue, name)
      if (!HASH.test(name)) {
        // Half-written entries from the hook start with a dot; anything else odd is removed.
        const info = await lstat(path).catch(() => null)
        if (info && (!name.startsWith('.') || Date.now() - info.mtimeMs > 60_000)) await remove(path)
        continue
      }
      let result
      for (let attempt = 0; ; attempt += 1) {
        try { result = await importTorrent(name) } catch (error) { log({ hash: name, result: 'failed', reason: error instanceof Error ? error.message : String(error) }); result = { hash: name, result: 'failed' } }
        if (result.result !== 'not-ready' || attempt >= queueRetries) break
        await delay(queueRetryMs)
      }
      results.push(result)
      await remove(path)
    }
    return results
  }

  // Every finished Family torrent that has no final outcome yet (published, already imported, review or skipped).
  async function scan() {
    await roots()
    const results = []
    for (const torrent of await qbittorrent.list(FAMILY_CATEGORY)) {
      const hash = text(torrent.hash).toLowerCase()
      if (!HASH.test(hash) || !(Number(torrent.progress) >= 1)) continue
      const state = await readState(hash)
      if (state && ['published', 'already-imported', 'review', 'skipped'].includes(state.result)) continue
      try { results.push(await importTorrent(hash)) } catch (error) { log({ hash, result: 'failed', reason: error instanceof Error ? error.message : String(error) }); results.push({ hash, result: 'failed' }) }
    }
    return results
  }

  return { importTorrent, drainQueue, scan, plan }
}

// qBittorrent through the agent's existing client and settings (TOMIFY_QBITTORRENT_URL and its login).
export async function qbittorrentForImport(env = process.env) {
  const { createQbittorrentClient, torrentConfig } = await import('./torrent.mjs')
  const config = torrentConfig(env)
  if (!config) throw new Error('TOMIFY_QBITTORRENT_URL is not set.')
  const client = createQbittorrentClient(config)
  return {
    torrent: (hash) => client.findByHash(hash),
    files: (hash) => client.files(hash),
    list: (category) => client.list(category),
  }
}

async function main(argv) {
  const args = argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const hashIndex = args.indexOf('--hash')
  const library = text(process.env.TOMIFIN_IMPORT_LIBRARY) || '/media/family'
  const stateDir = text(process.env.TOMIFIN_IMPORT_STATE_DIR) || text(process.env.STATE_DIRECTORY) || '/var/lib/tomifin-import'
  const moviesDir = text(process.env.TOMIFIN_IMPORT_MOVIES_SUBDIR)
  const importer = createFamilyImporter({ library, moviesDir, stateDir, qbittorrent: await qbittorrentForImport(), dryRun, probe: ffprobeReader(text(process.env.TOMIFIN_IMPORT_FFPROBE) || 'ffprobe') })
  let mode
  let results
  if (hashIndex >= 0) { mode = 'hash'; results = [await importer.importTorrent(args[hashIndex + 1])] }
  else if (args.includes('--queue')) { mode = 'queue'; results = await importer.drainQueue() }
  else if (args.includes('--scan')) { mode = 'scan'; results = await importer.scan() }
  else throw new Error('Use --hash <info hash>, --queue or --scan, optionally with --dry-run.')
  // Always one closing line, so a run that found nothing still shows in the journal.
  process.stdout.write(`${JSON.stringify({ result: 'done', mode, dryRun: dryRun || undefined, torrents: results.length })}\n`)
}

// Run as a command. Node resolves symlinks for the main module, and the agent is installed through the
// /opt/tomify/current symlink, so compare real paths.
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href } catch { return false }
}

if (isMain()) {
  main(process.argv).catch((error) => {
    process.stderr.write(`${JSON.stringify({ result: 'failed', reason: error instanceof Error ? error.message : String(error) })}\n`)
    process.exitCode = 1
  })
}
