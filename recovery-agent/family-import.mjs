// Tomifin Family importer. When qBittorrent finishes a Family torrent (category tomifin-family, saved under the
// hidden staging folder <library>/.downloads), this publishes it into the Jellyfin library, with its subtitles, as
// hardlinks: qBittorrent's own files are never moved, renamed or deleted, so the torrent keeps seeding.
//   a film:        <library>/<Movies>/Title (Year)/Title (Year).ext
//   TV episodes:   <library>/<TV>/Series/Season NN/Series - SNNENN[ - Episode title].ext
// Tomifin's Usenet downloads (tomifin-usenet.mjs) use the same checks through importDirectory(), with verified copies
// where SABnzbd's output cannot be hardlinked.
//
// Everything about a torrent (its name, file names, the hash a hook passes) is untrusted. Nothing is published unless
// every check passes; anything doubtful goes to <library>/.review/<hash>/ (hardlinks plus reason.json) instead, and
// nothing that already exists is ever overwritten. Run with --dry-run to see what would happen without writing.
//
//   node family-import.mjs --hash <info hash> [--dry-run]   import one torrent
//   node family-import.mjs --queue [--dry-run]              import every hash the qBittorrent hook queued
//   node family-import.mjs --scan [--dry-run]               import every finished Family torrent not yet handled
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { link, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PublishError, ensureChildFolder, fsyncDirectory, isArchiveName, materialise, placeNoClobber, sameContent, sha256File as sha256, walkCompleted } from './media-publish.mjs'

export const STAGING = '.downloads'
export const REVIEW = '.review'
export const PUBLISHING = '.publishing'
// A films or TV folder inside the library, such as Movies or TV; never hidden, never a path.
const MOVIES_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
export const DEFAULT_TV_DIR = 'TV'
export const QUEUE = '.tomifin-import-queue'
export const FAMILY_CATEGORY = 'tomifin-family'
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
// Records are named after the torrent's hash, or usenet-<Tomifin job id> for a Usenet download.
const KEY = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|usenet-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg'])
const SUBTITLE = new Set(['.srt'])
const PARTIAL = /\.(?:!qb|part|parts|crdownload|tmp)$/i
const SAMPLE = /(?:^|[^a-z])(?:sample|trailer|preview|teaser)(?:[^a-z]|$)/i
const COMPLETE_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP'])
// The main film must be this long according to ffprobe, so a trailer or sample is never published as the film.
const MIN_DURATION_SECONDS = 20 * 60
// Another video at least this share of the largest one's size makes the main file ambiguous (two parts, two cuts).
const RIVAL_SHARE = 0.4
// An episode must be at least this long according to ffprobe (short children's episodes run to about five minutes).
const MIN_EPISODE_SECONDS = 2 * 60

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
// TV names

// One word naming an episode, such as S02E04, s1e3, S01E01E02 or S01E01-E02 (consecutive episodes only).
const EPISODE_WORD = /^s(\d{1,2})e(\d{1,3})((?:-?e\d{1,3})*)$/i
const SEASON_WORD = /^s(\d{1,2})$/i
const SEASON_RANGE = /^s(\d{1,2})-s?(\d{1,2})$/i

function episodeWord(word) {
  const match = String(word).replace(/^-+|-+$/g, '').match(EPISODE_WORD)
  if (!match) return null
  const episodes = [Number(match[2]), ...[...match[3].matchAll(/e(\d{1,3})/gi)].map((part) => Number(part[1]))]
  // A run such as E01E02E03 must be consecutive; anything else (E01E05, E02E01) is not trusted.
  if (episodes.some((value, index) => index > 0 && value !== episodes[index - 1] + 1)) return { invalid: true }
  return { season: Number(match[1]), episodes }
}

// A title as words, or null when it is empty, carries release tags, or would not be a safe folder name.
function cleanTitle(list) {
  const titleWords = list.filter((word) => word !== '-')
  if (!titleWords.length || titleWords.some(isTag)) return null
  const title = titleWords.join(' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '')
  if (!title || title.length > 150 || title.startsWith('.') || !/[\p{L}\p{N}]/u.test(title) || /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(title)) return null
  return title
}

// The series named before an episode or season marker, with a year straight after the name kept as "(Year)".
function seriesFrom(list) {
  const titleWords = list.filter((word) => word !== '-')
  let year = null
  if (titleWords.length > 1 && YEAR.test(titleWords.at(-1))) year = Number(titleWords.pop())
  const title = cleanTitle(titleWords)
  return title ? { title, year, key: seriesKey(title), name: year ? `${title} (${year})` : title } : null
}

// Names compare without case, accents, punctuation or spacing: "MobLand", "Mob.Land" and "mobland" agree.
export function seriesKey(title) {
  return String(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
}

// What an episode file's name says: series (when named), season, episode numbers and an episode title when one is
// clearly there. Returns null when there is no episode marker, and { invalid } when the marker is doubtful.
export function parseEpisodeName(name) {
  const list = words(name)
  const markers = list.map((word, index) => ({ index, parsed: episodeWord(word) })).filter((entry) => entry.parsed)
  if (!markers.length) return null
  if (markers.length > 1 || markers[0].parsed.invalid) return { invalid: true }
  const { index, parsed } = markers[0]
  const series = seriesFrom(list.slice(0, index))
  // The episode title: the words after the marker up to the first release tag, year or language. Only kept when it is
  // clearly a title: after a " - " separator, or followed by release tags (so a bare release group is never a title).
  const after = list.slice(index + 1)
  let start = 0
  const dashed = after[0] === '-'
  while (after[start] === '-') start += 1
  const titleWords = []
  let stoppedByTag = false
  for (const word of after.slice(start)) {
    if (word === '-') break
    if (isTag(word) || YEAR.test(word) || LANGUAGE_WORDS.has(word.toLowerCase()) || episodeWord(word)) { stoppedByTag = true; break }
    titleWords.push(word)
  }
  const title = titleWords.length && titleWords.length <= 12 && (dashed || stoppedByTag) ? cleanTitle(titleWords) : null
  return { series, season: parsed.season, episodes: parsed.episodes, title }
}

// What a torrent (or Usenet download) name says about a series: its name and the season it names, if any.
export function parseSeriesRelease(name) {
  const list = words(name)
  const seasons = new Set()
  let multiple = false
  let stop = -1
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index].replace(/^-+|-+$/g, '')
    const episode = episodeWord(word)
    const range = word.match(SEASON_RANGE)
    const named = /^(?:season|series)$/i.test(word) && /^\d{1,2}$/.test(list[index + 1] || '')
    if (episode && !episode.invalid) seasons.add(episode.season)
    else if (SEASON_WORD.test(word)) seasons.add(Number(word.match(SEASON_WORD)[1]))
    else if (range) multiple = true
    else if (named) seasons.add(Number(list[index + 1]))
    else if (!/^complete$/i.test(word) && !isTag(word)) continue
    if (stop < 0) stop = index
  }
  if (stop < 0) return { series: null, season: null }
  return { series: seriesFrom(list.slice(0, stop)), season: !multiple && seasons.size === 1 ? [...seasons][0] : null }
}

// The season a folder of the download names ("Season 2", "S02", "Show.S02E01.1080p"), or null.
function folderSeason(relativePath) {
  const seasons = new Set()
  for (const part of dirname(relativePath).split(/[\\/]/).filter((value) => value && value !== '.')) {
    const list = words(part)
    for (let index = 0; index < list.length; index += 1) {
      const episode = episodeWord(list[index])
      if (episode && !episode.invalid) seasons.add(episode.season)
      else if (SEASON_WORD.test(list[index])) seasons.add(Number(list[index].match(SEASON_WORD)[1]))
      else if (/^(?:season|series)$/i.test(list[index]) && /^\d{1,2}$/.test(list[index + 1] || '')) seasons.add(Number(list[index + 1]))
    }
  }
  return seasons.size === 1 ? [...seasons][0] : seasons.size ? -1 : null
}

const pad = (value) => String(value).padStart(2, '0')
export function episodeCode(season, episodes) { return `S${pad(season)}E${pad(episodes[0])}${episodes.length > 1 ? `-E${pad(episodes.at(-1))}` : ''}` }

// ---------------------------------------------------------------------------------------------------------------
// Files

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

function ident(key) { return /^usenet-/.test(key) ? { key } : { hash: key } }

export function createFamilyImporter({ library, moviesDir = '', tvDir = DEFAULT_TV_DIR, stateDir, qbittorrent = null, probe = ffprobeReader(), log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`), stableMs = 5000, queueRetries = 6, queueRetryMs = 10_000, dryRun = false, now = () => new Date() }) {
  if (!isAbsolute(text(library))) throw new Error('The Family library must be an absolute path.')
  if (text(moviesDir) && !MOVIES_DIR.test(text(moviesDir))) throw new Error('The films folder must be one plain folder name inside the Family library.')
  if (!MOVIES_DIR.test(text(tvDir))) throw new Error('The TV folder must be one plain folder name inside the Family library.')
  if (text(tvDir).toLowerCase() === text(moviesDir).toLowerCase()) throw new Error('The TV folder must be separate from the films folder.')
  const paths = {}

  async function roots() {
    if (paths.library) return paths
    paths.library = await realpath(library)
    paths.review = join(paths.library, REVIEW)
    paths.movies = paths.library
    if (text(moviesDir)) {
      paths.movies = await realpath(join(paths.library, text(moviesDir))).catch(() => { throw new ImportError('no-movies', `${join(library, text(moviesDir))} does not exist.`) })
      if (!strictlyWithin(paths.movies, paths.library)) throw new ImportError('bad-movies', 'The films folder must be inside the Family library.')
    }
    // Created when the first series is published.
    paths.tv = join(paths.library, text(tvDir))
    paths.publishing = join(paths.library, PUBLISHING)
    return paths
  }

  // qBittorrent's hidden staging folder; only torrents need it.
  async function stagingRoot() {
    await roots()
    if (paths.staging) return paths.staging
    const staging = await realpath(join(paths.library, STAGING)).catch(() => { throw new ImportError('no-staging', `${join(library, STAGING)} does not exist.`) })
    if (!strictlyWithin(staging, paths.library)) throw new ImportError('bad-staging', 'The staging folder must be inside the Family library.')
    paths.staging = staging
    return staging
  }

  function statePath(key) { return join(stateDir, `${key}.json`) }
  async function readState(key) { try { return JSON.parse(await readFile(statePath(key), 'utf8')) } catch { return null } }
  async function writeState(key, value) {
    if (dryRun) return
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${statePath(key)}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, statePath(key))
  }

  // Folders are created 0775 without the setgid bit: the library's own setgid bit already passes the media-family
  // group down, and the units' RestrictSUIDSGID=yes refuses any mkdir that asks for setgid (EPERM).
  async function ensureIgnoredFolder(path) {
    if (dryRun) return
    await mkdir(path, { recursive: true, mode: 0o775 })
    await writeFile(join(path, '.ignore'), '', { flag: 'a' })
  }

  // Resolves one file of a download to its real path, and refuses anything that is, or passes through, a link out of
  // the download's own folder (qBittorrent's staging folder, or SABnzbd's finished folder).
  async function sourceFile(root, relativePath, allowedRoot) {
    const relativeName = text(relativePath)
    if (!relativeName || isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) throw new ImportError('unsafe-path', `Unsafe file name in the download: ${JSON.stringify(relativeName).slice(0, 200)}`, { review: true })
    const joined = resolve(root, relativeName)
    let real
    try { real = await realpath(joined) } catch { throw new ImportError('missing', `A file of the download is missing: ${relativeName.slice(0, 200)}`, { retry: true }) }
    if (!strictlyWithin(real, allowedRoot) || real !== joined) throw new ImportError('unsafe-path', `A file of the download resolves outside the staging folder: ${relativeName.slice(0, 200)}`, { review: true })
    const info = await lstat(real)
    if (!info.isFile()) throw new ImportError('unsafe-path', `Not a regular file: ${relativeName.slice(0, 200)}`, { review: true })
    return { relative: relativeName, path: real, info }
  }

  // Checks that a file is complete and not changing: the size the downloader expects, not empty, not a partial file,
  // and the same size and modification time a few seconds apart.
  async function stable(file, expectedSize) {
    if (PARTIAL.test(file.path)) throw new ImportError('incomplete', `Still a partial file: ${file.relative.slice(0, 200)}`, { retry: true })
    if (file.info.size === 0) throw new ImportError('empty', `Empty file: ${file.relative.slice(0, 200)}`, { review: true })
    if (expectedSize !== null && file.info.size !== expectedSize) throw new ImportError('incomplete', `${file.relative.slice(0, 200)} is ${file.info.size} bytes, qBittorrent expects ${expectedSize}`, { retry: true })
    await delay(stableMs)
    const again = await lstat(file.path)
    if (again.size !== file.info.size || again.mtimeMs !== file.info.mtimeMs || again.ino !== file.info.ino) throw new ImportError('unstable', `${file.relative.slice(0, 200)} is still changing`, { retry: true })
  }

  // A finished Family torrent as a download to import: its save folder and its wanted files.
  async function torrentSource(torrent, files) {
    const staging = await stagingRoot()
    if (text(torrent.category) !== FAMILY_CATEGORY) throw new ImportError('not-family', 'Not a Tomifin Family torrent.')
    if (!(Number(torrent.progress) >= 1) || Number(torrent.amount_left) > 0 || !COMPLETE_STATES.has(text(torrent.state))) throw new ImportError('not-complete', `qBittorrent does not report the torrent as complete (state ${text(torrent.state) || 'unknown'}).`, { retry: true })
    const savePath = text(torrent.save_path)
    let root
    try { root = await realpath(savePath) } catch { throw new ImportError('missing', 'The torrent\'s save folder is missing.', { retry: true }) }
    if (!within(root, staging) || root !== resolve(savePath)) throw new ImportError('unsafe-path', `The torrent is saved outside ${staging}.`, { review: true })
    const wanted = (Array.isArray(files) ? files : []).filter((file) => Number(file.priority) !== 0)
    if (!wanted.length) throw new ImportError('no-files', 'qBittorrent lists no files for the torrent.', { retry: true })
    if (wanted.some((file) => Number(file.progress) < 1)) throw new ImportError('incomplete', 'qBittorrent has not finished every file.', { retry: true })
    return { key: text(torrent.hash).toLowerCase(), name: text(torrent.name), root, allowedRoot: staging, mode: 'link', entries: wanted.map((entry) => ({ name: text(entry.name), size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null })) }
  }

  // Works out what to publish, without writing anything: a film, or TV episodes.
  async function planFiles(source) {
    const videos = []
    const subtitles = []
    let ignored = 0
    for (const entry of source.entries) {
      const name = entry.name
      const extension = extname(name).toLowerCase()
      const isVideo = VIDEO.has(extension)
      const isSubtitle = SUBTITLE.has(extension)
      // Samples, artwork, .txt/.nfo/.url adverts and everything else are left out.
      if ((!isVideo && !isSubtitle) || SAMPLE.test(name.replace(/\.[^.]+$/, ''))) { ignored += 1; continue }
      const file = await sourceFile(source.root, name, source.allowedRoot)
      ;(isVideo ? videos : subtitles).push({ ...file, expectedSize: entry.size })
    }
    if (!videos.length) throw new ImportError('no-video', 'The download has no video file to publish.', { review: true })
    const episodes = videos.map((video) => parseEpisodeName(basename(video.relative)))
    if (episodes.some(Boolean)) return planTv(source, videos, subtitles, episodes, ignored)

    videos.sort((a, b) => b.info.size - a.info.size)
    const [main, rival] = videos
    if (rival && rival.info.size >= main.info.size * RIVAL_SHARE) throw new ImportError('ambiguous-video', `More than one large video file (${basename(main.relative)}, ${basename(rival.relative)}): which is the film is not clear.`, { review: true })

    for (const file of [main, ...subtitles]) await stable(file, file.expectedSize)
    const probed = await probe(main.path)
    if (!probed.ok) throw probeError(main, probed)
    if (probed.duration !== null && probed.duration < MIN_DURATION_SECONDS) throw new ImportError('too-short', `${basename(main.relative)} is only ${Math.round(probed.duration / 60)} minutes long: not a film.`, { review: true })

    const { identity, reason } = filmIdentity(source.name, main.relative)
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
    return { kind: 'film', identity, outputs, ignored, skippedSubtitles: skipped, main }
  }

  function probeError(file, probed) {
    return new ImportError(probed.reason === 'ffprobe is not installed' ? 'no-ffprobe' : 'unreadable', `${basename(file.relative)}: ${probed.reason}`, { review: probed.reason !== 'ffprobe is not installed', retry: probed.reason === 'ffprobe is not installed' })
  }

  // TV: every video must name its episode, the series must be agreed (or named only once), seasons must match what
  // the download and its folders say, and no two different files may claim the same episode.
  async function planTv(source, videos, subtitles, episodes, ignored) {
    const review = (code, message) => new ImportError(code, message, { review: true })
    videos.forEach((video, index) => {
      if (!episodes[index]) throw review('mixed-content', `${basename(video.relative)} has no episode number, alongside episode files: what to publish is not clear.`)
      if (episodes[index].invalid) throw review('ambiguous-episode', `${basename(video.relative)}: its episode number is not clear.`)
    })
    const release = parseSeriesRelease(source.name)
    const named = episodes.map((episode) => episode.series).filter(Boolean)
    const keys = [...new Set(named.map((series) => series.key))]
    if (keys.length > 1) throw review('ambiguous-series', `The episode files name different series (${[...new Set(named.map((series) => series.title))].slice(0, 3).join(', ')}).`)
    if (release.series && named.length && release.series.key !== keys[0]) throw review('ambiguous-series', `The download is named "${release.series.title}" but its files say "${named[0].title}".`)
    const years = [...new Set([...named, release.series].filter(Boolean).map((series) => series.year).filter((year) => year !== null))]
    if (years.length > 1) throw review('ambiguous-series', `The download and its files give different years for the series (${years.join(', ')}).`)
    const titles = [...new Set(named.map((series) => series.title))]
    const title = titles.length === 1 ? titles[0] : release.series && named.length ? release.series.title : named.length ? titles.sort()[0] : release.series?.title
    if (!title) throw review('ambiguous-series', 'The series name could not be read from the download or its file names.')
    const series = years.length ? `${title} (${years[0]})` : title
    if (release.season !== null && episodes.some((episode) => episode.season !== release.season)) throw review('season-mismatch', `The download names season ${release.season}, but it holds episodes of other seasons.`)
    videos.forEach((video, index) => {
      const folder = folderSeason(video.relative)
      if (folder === -1 || (folder !== null && folder !== episodes[index].season)) throw review('season-mismatch', `${video.relative.slice(0, 200)} is in a folder for another season.`)
    })

    // Group the files by the episodes they claim. Two different claims on one episode (E02 and E01-E02) are a conflict.
    const groups = new Map()
    const claims = new Map()
    videos.forEach((video, index) => {
      const episode = episodes[index]
      const code = episodeCode(episode.season, episode.episodes)
      for (const number of episode.episodes) {
        const claim = `${episode.season}:${number}`
        if (claims.has(claim) && claims.get(claim) !== code) throw review('duplicate-episode', `More than one file claims ${episodeCode(episode.season, [number])}.`)
        claims.set(claim, code)
      }
      if (!groups.has(code)) groups.set(code, [])
      groups.get(code).push({ video, episode })
    })

    await Promise.all([...videos, ...subtitles].map((file) => stable(file, file.expectedSize)))
    for (const [code, members] of groups) {
      if (members.length < 2) continue
      // Byte-identical copies (the same episode twice) are fine: one is published. Anything else is not guessed.
      const [first, ...rest] = members.sort((a, b) => a.video.relative.localeCompare(b.video.relative))
      const reference = await sha256(first.video.path)
      for (const member of rest) {
        if (member.video.info.size !== first.video.info.size || await sha256(member.video.path) !== reference) throw review('duplicate-episode', `Different files claim ${code} (${basename(first.video.relative)}, ${basename(member.video.relative)}).`)
      }
      groups.set(code, [first])
    }

    const outputs = []
    const skipped = []
    const taken = new Set()
    const byCode = new Map()
    for (const [code, [{ video, episode }]] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const probed = await probe(video.path)
      if (!probed.ok) throw probeError(video, probed)
      if (probed.duration !== null && probed.duration < MIN_EPISODE_SECONDS) throw review('too-short', `${basename(video.relative)} is only ${Math.round(probed.duration)} seconds long: not an episode.`)
      const base = `${series} - ${code}${episode.title ? ` - ${episode.title}` : ''}`
      const folder = `Season ${pad(episode.season)}`
      const name = `${base}${extname(video.relative).toLowerCase()}`
      if (!safeName(series) || !safeName(name)) throw review('unsafe-name', `The episode name "${name.slice(0, 200)}" is not a safe file name.`)
      outputs.push({ source: video, folder, name, kind: 'video', code })
      taken.add(`${folder}/${name}`.toLowerCase())
      byCode.set(code, { video, base, folder })
    }
    // Subtitles belong to the episode their own name (or folder) names, or whose file name they start with.
    for (const subtitle of [...subtitles].sort((a, b) => b.info.size - a.info.size)) {
      const episode = subtitleEpisode(subtitle.relative)
      let owner = episode ? byCode.get(episode) : null
      if (!owner) {
        const stem = basename(subtitle.relative).replace(/\.srt$/i, '').toLowerCase()
        const matches = [...byCode.values()].filter((entry) => stem.startsWith(basename(entry.video.relative).replace(/\.[^.]+$/, '').toLowerCase()))
        owner = matches.length === 1 ? matches[0] : null
      }
      if (!owner) { skipped.push(subtitle.relative); continue }
      const { language, flags } = subtitleLanguage(subtitle.relative, basename(owner.video.relative))
      const name = `${owner.base}${language ? `.${language}` : ''}${flags.map((flag) => `.${flag}`).join('')}.srt`
      const key = `${owner.folder}/${name}`.toLowerCase()
      if (taken.has(key)) { skipped.push(subtitle.relative); continue }
      taken.add(key)
      outputs.push({ source: subtitle, folder: owner.folder, name, kind: 'subtitle' })
    }
    return { kind: 'tv', series, seasons: [...new Set(episodes.map((episode) => episode.season))].sort((a, b) => a - b), outputs, ignored, skippedSubtitles: skipped }
  }

  function subtitleEpisode(relativePath) {
    const own = parseEpisodeName(basename(relativePath).replace(/\.srt$/i, ''))
    if (own && !own.invalid) return episodeCode(own.season, own.episodes)
    const found = new Set()
    for (const part of dirname(relativePath).split(/[\\/]/)) {
      for (const word of words(part)) { const episode = episodeWord(word); if (episode && !episode.invalid) found.add(episodeCode(episode.season, episode.episodes)) }
    }
    return found.size === 1 ? [...found][0] : null
  }

  // Works out what to publish for a torrent (exported for tests and dry runs).
  async function plan(torrent, files) {
    await roots()
    return planFiles(await torrentSource({ ...torrent, hash: torrent.hash || '' }, files))
  }

  async function sameFilesystem(from, path) {
    const [source, target] = await Promise.all([stat(from), stat(path)])
    if (source.dev !== target.dev) throw new ImportError('cross-device', `${path} is on a different filesystem from the staging folder, so it cannot be hardlinked.`)
  }

  // Hardlinks the download's files into <library>/.review/<key>/ with the reason (and a machine-readable code), so
  // nothing is lost or guessed. Files that cannot be hardlinked there (another filesystem) stay where they are.
  async function sendToReview(key, name, error, details = {}) {
    const folder = join(paths.review, key)
    const entry = { ...ident(key), name: text(name).slice(0, 300), result: 'review', code: error.code, reason: error.message, ...details }
    if (dryRun) { log({ ...entry, dryRun: true }); return entry }
    await ensureIgnoredFolder(paths.review)
    const exists = await lstat(folder).then(() => true, () => false)
    if (!exists) {
      await mkdir(folder, { mode: 0o775 })
      for (const file of details.files || []) {
        const target = join(folder, basename(file))
        await link(file, target).catch((failure) => log({ ...ident(key), result: 'review-link-failed', file: basename(file), reason: failure.code || failure.message }))
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

  async function previousOutcome(key) {
    const previous = await readState(key)
    if (previous && ['published', 'already-imported'].includes(previous.result)) {
      const intact = await Promise.all((previous.published || []).map(async (path) => Boolean(await lstat(path).catch(() => null))))
      if (intact.every(Boolean)) { log({ ...ident(key), name: previous.name, result: 'unchanged', reason: `already ${previous.result}` }); return { result: 'unchanged', previous } }
    }
    if (previous?.result === 'review') { log({ ...ident(key), name: previous.name, result: 'unchanged', reason: 'waiting for review' }); return { result: 'unchanged', previous } }
    return null
  }

  // Plans and publishes one download. Doubtful ones go to review; ones not ready yet are left for the next run.
  async function importSource(key, name, makeSource, reviewFiles) {
    let source
    let planned
    try {
      source = await makeSource()
      planned = await planFiles(source)
    } catch (caught) {
      const error = caught instanceof PublishError ? new ImportError(caught.code, caught.message, { review: caught.review, retry: caught.retry }) : caught
      if (!(error instanceof ImportError)) throw error
      if (error.review) {
        const entry = await sendToReview(key, name, error, { files: await reviewFiles().catch(() => []) })
        await writeState(key, { ...entry, at: now().toISOString() })
        return entry
      }
      log({ ...ident(key), name: text(name).slice(0, 300), result: error.retry ? 'not-ready' : 'skipped', code: error.code, reason: error.message })
      if (!error.retry && !dryRun && error.code !== 'not-family') await writeState(key, { ...ident(key), name: text(name).slice(0, 300), result: 'skipped', code: error.code, reason: error.message, at: now().toISOString() })
      return { ...ident(key), result: error.retry ? 'not-ready' : 'skipped', code: error.code, reason: error.message }
    }
    return planned.kind === 'tv' ? publishTv(key, name, source, planned) : publishFilm(key, name, source, planned)
  }

  async function publishFilm(key, name, source, planned) {
    const { identity, outputs } = planned
    const destination = join(paths.movies, identity.name)
    const base = { ...ident(key), name: text(name).slice(0, 300), title: identity.title, year: identity.year }
    if (source.mode === 'link') await sameFilesystem(source.allowedRoot, paths.movies)

    const exists = await lstat(destination).then(() => true, () => false)
    if (exists) {
      const match = await existingMatch(destination, outputs)
      if (match === 'same') {
        const entry = { ...base, result: 'already-imported', published: [destination] }
        log({ ...entry, dryRun: dryRun || undefined })
        await writeState(key, { ...entry, sources: sources(outputs), at: now().toISOString() })
        return entry
      }
      const error = new ImportError('conflict', match === 'different' ? `${destination} already has a different ${outputs[0].name}; it was not overwritten.` : `${destination} already exists with other contents; it was not changed.`)
      const entry = await sendToReview(key, name, error, { ...base, files: outputs.map((output) => output.source.path) })
      await writeState(key, { ...entry, at: now().toISOString() })
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
    const work = join(paths.publishing, `${key}-${randomUUID()}`)
    const building = join(work, identity.name)
    await mkdir(building, { recursive: true, mode: 0o775 })
    try {
      for (const output of outputs) {
        const target = join(building, output.name)
        if (source.mode === 'link') {
          await link(output.source.path, target)
          const [made, original] = await Promise.all([lstat(target), lstat(output.source.path)])
          if (made.ino !== original.ino || made.dev !== original.dev || original.nlink < 2) throw new ImportError('link-failed', `The hardlink for ${output.name} did not take.`)
        } else {
          // A verified copy (fsync and SHA-256) where the download cannot be hardlinked.
          await materialise(output.source.path, target, source.mode)
        }
      }
      if (source.mode !== 'link') await fsyncDirectory(building)
      // rename() of a folder onto an existing, non-empty one fails, so a film published meanwhile is never replaced.
      await rename(building, destination)
    } catch (error) {
      for (const output of outputs) await unlink(join(building, output.name)).catch(() => {})
      await rmdir(building).catch(() => {})
      await rmdir(work).catch(() => {})
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
        const entry = await sendToReview(key, name, new ImportError('conflict', `${destination} appeared while publishing; it was not changed.`), { ...base, files: outputs.map((output) => output.source.path) })
        await writeState(key, { ...entry, at: now().toISOString() })
        return entry
      }
      throw error
    }
    await rmdir(work).catch(() => {})
    const entry = { ...base, result: 'published', published: publishedPaths, ignoredFiles: planned.ignored, skippedSubtitles: planned.skippedSubtitles.length ? planned.skippedSubtitles : undefined }
    log(entry)
    await writeState(key, { ...entry, sources: sources(outputs), at: now().toISOString() })
    return entry
  }

  // TV episodes go into <TV>/<Series>/Season NN/, which may already hold other episodes, so each file is put in place
  // on its own with link(), which never replaces a file and makes it appear complete in one step. Copies are built
  // and checked in the hidden publishing folder first. An existing file with the same content counts as imported;
  // a different one sends the whole download to review before anything is published.
  async function publishTv(key, name, source, planned) {
    const { series, outputs } = planned
    const base = { ...ident(key), name: text(name).slice(0, 300), series, seasons: planned.seasons }
    const toReview = async (error) => {
      const entry = await sendToReview(key, name, error, { ...base, files: outputs.map((output) => output.source.path) })
      await writeState(key, { ...entry, at: now().toISOString() })
      return entry
    }
    const tvInfo = await lstat(paths.tv).catch(() => null)
    if (tvInfo && (tvInfo.isSymbolicLink() || !tvInfo.isDirectory() || await realpath(paths.tv) !== paths.tv)) throw new ImportError('bad-tv', `${paths.tv} is not a plain folder inside the Family library.`)
    const targets = outputs.map((output) => ({ ...output, target: join(paths.tv, series, output.folder, output.name) }))
    const done = new Set()
    try {
      if (tvInfo) {
        const seriesFolder = await ensureChildFolder(paths.tv, series, { create: false })
        for (const folder of new Set(targets.map((output) => output.folder))) if (seriesFolder) await ensureChildFolder(seriesFolder, folder, { create: false })
      }
      for (const output of targets) {
        if (!await lstat(output.target).catch(() => null)) continue
        if (!await sameContent(output.target, output.source.path)) return toReview(new ImportError('conflict', `${output.target} already has a different file; it was not overwritten.`))
        done.add(output.target)
      }
    } catch (error) {
      if (error instanceof PublishError) return toReview(new ImportError(error.code, error.message))
      throw error
    }
    const publishedPaths = targets.map((output) => output.target)
    if (done.size === targets.length) {
      const entry = { ...base, result: 'already-imported', published: publishedPaths }
      log({ ...entry, dryRun: dryRun || undefined })
      await writeState(key, { ...entry, sources: sources(outputs), at: now().toISOString() })
      return entry
    }
    if (dryRun) {
      const entry = { ...base, result: 'would-publish', published: publishedPaths, ignoredFiles: planned.ignored, skippedSubtitles: planned.skippedSubtitles }
      log({ ...entry, dryRun: true })
      return entry
    }
    if (source.mode === 'link') await sameFilesystem(source.allowedRoot, paths.library)
    if (!tvInfo) await mkdir(paths.tv, { mode: 0o775 }).catch((error) => { if (error?.code !== 'EEXIST') throw error })
    let work = null
    try {
      await ensureChildFolder(paths.library, text(tvDir))
      const seriesFolder = await ensureChildFolder(paths.tv, series)
      for (const folder of new Set(targets.map((output) => output.folder))) await ensureChildFolder(seriesFolder, folder)
      for (const [index, output] of targets.entries()) {
        if (done.has(output.target)) continue
        try {
          if (source.mode === 'link') {
            await link(output.source.path, output.target)
            const [made, original] = await Promise.all([lstat(output.target), lstat(output.source.path)])
            if (made.ino !== original.ino || made.dev !== original.dev) throw new ImportError('link-failed', `The hardlink for ${output.name} did not take.`)
          } else {
            if (!work) { await ensureIgnoredFolder(paths.publishing); work = join(paths.publishing, `${key}-${randomUUID()}`); await mkdir(work, { mode: 0o775 }) }
            const finished = join(work, String(index))
            await materialise(output.source.path, finished, source.mode)
            await placeNoClobber(finished, output.target)
          }
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
          // Something appeared at that name meanwhile: kept if it is this file, otherwise never replaced.
          if (await sameContent(output.target, output.source.path)) continue
          return toReview(new ImportError('conflict', `${output.target} appeared while publishing with different contents; it was not changed.`))
        }
      }
    } catch (error) {
      if (error instanceof PublishError && error.review) return toReview(new ImportError(error.code, error.message))
      throw error
    } finally {
      if (work) { for (const name of await readdir(work).catch(() => [])) await unlink(join(work, name)).catch(() => {}); await rmdir(work).catch(() => {}) }
    }
    const entry = { ...base, result: 'published', published: publishedPaths, ignoredFiles: planned.ignored, skippedSubtitles: planned.skippedSubtitles.length ? planned.skippedSubtitles : undefined }
    log(entry)
    await writeState(key, { ...entry, sources: sources(outputs), at: now().toISOString() })
    return entry
  }

  async function importTorrent(hashValue) {
    const hash = text(hashValue).toLowerCase()
    if (!HASH.test(hash)) throw new ImportError('bad-hash', 'Not a torrent info hash.')
    await stagingRoot()
    const previous = await previousOutcome(hash)
    if (previous) return previous
    if (!qbittorrent) throw new Error('qBittorrent is not configured for the importer.')
    const torrent = await qbittorrent.torrent(hash)
    if (!torrent) throw new ImportError('not-in-qbittorrent', 'qBittorrent does not know this torrent.')
    return importSource(hash, torrent.name, async () => torrentSource(torrent, await qbittorrent.files(hash)), () => reviewFiles(torrent))
  }

  // A finished Usenet download (SABnzbd's output folder for one Tomifin job), through the same checks as a torrent.
  // root must be strictly inside allowedRoot (the configured Usenet download folder). Nothing in it is changed: it is
  // hardlinked when that is possible and mode allows ('auto'), and otherwise copied and verified.
  async function importDirectory({ key, name, root, allowedRoot, mode = 'auto', maxBytes = Number.POSITIVE_INFINITY }) {
    if (!/^usenet-/.test(text(key)) || !KEY.test(text(key))) throw new ImportError('bad-key', 'Not a Usenet download.')
    if (!['auto', 'copy', 'link'].includes(mode)) throw new Error('mode must be auto, copy or link.')
    await roots()
    const previous = await previousOutcome(key)
    if (previous) return previous
    let walked = []
    const makeSource = async () => {
      const allowed = await realpath(allowedRoot)
      const real = await realpath(root).catch(() => { throw new ImportError('missing', 'The finished download folder is missing.', { retry: true }) })
      if (!strictlyWithin(real, allowed) || real !== resolve(root)) throw new ImportError('unsafe-path', 'The finished download is outside the Usenet download folder.', { review: true })
      const { files } = await walkCompleted(real, { maxBytes })
      walked = files
      if (files.some((file) => isArchiveName(file.relative))) throw new ImportError('archives-remain', 'The download still holds archives: SABnzbd did not unpack it fully.', { review: true })
      return { key, name: text(name), root: real, allowedRoot: allowed, mode, entries: files.map((file) => ({ name: file.relative, size: file.size })) }
    }
    const reviewFiles = async () => walked.filter((file) => VIDEO.has(extname(file.relative).toLowerCase()) || SUBTITLE.has(extname(file.relative).toLowerCase())).map((file) => file.path)
    return importSource(key, name, makeSource, reviewFiles)
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
      try { found.push((await sourceFile(root, entry.name, paths.staging)).path) } catch { /* Left out of review. */ }
    }
    return found
  }

  // Hashes queued by the qBittorrent hook. A torrent that is not ready yet (qBittorrent can still be moving it out of
  // its temporary folder when the hook fires) is retried a few times in the same run. Each entry is then removed,
  // whatever the outcome; one still not ready is picked up again by --scan. A queue that cannot be read or emptied is
  // an error, never silently skipped: the path unit would otherwise start the importer again and again.
  async function drainQueue() {
    const queue = join(await stagingRoot(), QUEUE)
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
    await stagingRoot()
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

  return { importTorrent, importDirectory, drainQueue, scan, plan, readState }
}

function safeName(value) { return Boolean(value) && value.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith('.') && value.trim() === value }

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
  const tvDir = text(process.env.TOMIFIN_IMPORT_TV_SUBDIR) || DEFAULT_TV_DIR
  const importer = createFamilyImporter({ library, moviesDir, tvDir, stateDir, qbittorrent: await qbittorrentForImport(), dryRun, probe: ffprobeReader(text(process.env.TOMIFIN_IMPORT_FFPROBE) || 'ffprobe') })
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
