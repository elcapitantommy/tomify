// BPM, genre and mood tags, so the DJ can build sets of one style or tempo. Navidrome reads BPM, GENRE and MOOD
// tags and returns them on every song (bpm, genres, moods), but never works them out itself. The agent measures
// tempo locally with bpm-tools and looks genre and mood up on MusicBrainz (and Last.fm when there is a key), then
// writes whatever a file is missing with an ffmpeg stream copy: tags change, audio never does. Imports run it over
// their staged derivatives before ReplayGain tagging and the manifest's sha256; style-backfill.mjs runs it over an
// existing library. Best effort throughout: a missing tool, a failed lookup or an unreadable file is logged and the
// file is left as it was.
import { spawn as nodeSpawn } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { ffprobeTagJsonFormat } from './metadata.mjs'
import { decodeToolOutput, foldName } from './text-encoding.mjs'

// The containers ffmpeg can rewrite tags for without losing anything, and the tag names each one uses.
// MP4 has no mood atom ffmpeg writes, so M4A files get BPM and genre only. ffprobe can't read MP4's tmpo atom back,
// so an M4A's tempo is always measured and written again.
const vorbis = { bpm: 'BPM', genre: 'GENRE', mood: 'MOOD', checked: 'TOMIFY_STYLE_CHECKED', stream: true }
const STYLE_FORMATS = {
  '.flac': { ...vorbis, stream: false },
  '.ogg': vorbis, '.oga': vorbis, '.opus': vorbis, '.spx': vorbis,
  '.mp3': { bpm: 'TBPM', genre: 'genre', mood: 'TMOO', checked: 'TOMIFY_STYLE_CHECKED', stream: false },
  '.m4a': { bpm: 'tmpo', genre: 'genre', mood: null, checked: null, stream: false },
  '.mp4': { bpm: 'tmpo', genre: 'genre', mood: null, checked: null, stream: false },
}
export const STYLE_EXTENSIONS = new Set(Object.keys(STYLE_FORMATS))

// Last.fm and MusicBrainz tags that describe a mood, folded into a few moods the DJ can ask for.
export const MOODS = {
  chill: ['chill', 'chillout', 'chill out', 'chilled', 'mellow', 'relaxing', 'relaxed', 'laid back', 'laid-back', 'calm', 'soothing'],
  upbeat: ['upbeat', 'happy', 'feel good', 'feelgood', 'fun', 'cheerful', 'uplifting', 'summer', 'sunny'],
  energetic: ['energetic', 'energy', 'high energy', 'party', 'workout', 'driving', 'banger', 'bangers'],
  dark: ['dark', 'moody', 'brooding', 'haunting', 'sinister'],
  sad: ['sad', 'melancholic', 'melancholy', 'melancholia', 'depressing', 'heartbreak', 'sorrow'],
  romantic: ['romantic', 'love', 'love songs', 'sensual', 'sexy'],
  dreamy: ['dreamy', 'atmospheric', 'ethereal', 'hypnotic'],
  aggressive: ['aggressive', 'angry', 'intense', 'furious'],
}
const moodOf = new Map(Object.entries(MOODS).flatMap(([mood, words]) => words.map((word) => [word, mood])))
// Genre tags that say nothing, treated as missing.
const EMPTY_GENRES = new Set(['', 'other', 'unknown', 'misc', 'genre', 'none', 'music'])
const UPPER_WORDS = new Set(['uk', 'us', 'edm', 'idm', 'ebm', 'r&b', 'dnb', 'mpb', 'jpop', 'kpop'])
const MAX_GENRES = 3
const MAX_MOODS = 2
const USER_AGENT = 'Tomify/0.1 (https://app.tomify.tomdixon.uk)'

function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }
const text = (value) => String(value ?? '').trim()

// "deep house" -> "Deep House", "drum and bass" -> "Drum and Bass", "uk garage" -> "UK Garage".
export function genreName(name) {
  return text(name).split(/\s+/).map((word, index) => {
    const lower = word.toLowerCase()
    if (UPPER_WORDS.has(lower)) return lower.toUpperCase()
    if (index > 0 && ['and', 'of', 'n', "'n'"].includes(lower)) return lower
    return lower.replace(/(^|-)(\p{L})/gu, (_, dash, letter) => dash + letter.toUpperCase())
  }).join(' ')
}

/** Tags from an ffprobe JSON report (format and stream tags), keyed by lower-case letters and digits only. */
export function probedTags(report) {
  const tags = {}
  for (const source of [report?.format?.tags, ...(report?.streams ?? []).map((stream) => stream?.tags)]) {
    for (const [key, value] of Object.entries(source || {})) {
      const name = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (name && text(value) && tags[name] === undefined) tags[name] = text(value)
    }
  }
  return tags
}

/** What a file already has and what a lookup would need to find it. */
export function existingStyle(tags) {
  const bpm = Number.parseFloat(tags.bpm ?? tags.tbpm ?? tags.tmpo ?? '')
  const genre = text(tags.genre)
  return {
    bpm: bpm > 0 ? bpm : null,
    genre: EMPTY_GENRES.has(genre.toLowerCase()) ? '' : genre,
    mood: text(tags.mood ?? tags.tmoo),
    checked: Boolean(tags.tomifystylechecked),
    recordingId: tags.musicbrainztrackid || tags.musicbrainzrecordingid || null,
    releaseGroupId: tags.musicbrainzreleasegroupid || null,
    artist: text(tags.artist || tags.albumartist),
    title: text(tags.title),
  }
}

/** Up to three genres by vote count, most voted first. */
export function topGenres(list) {
  return [...(list ?? [])].filter((genre) => text(genre?.name) && Number(genre.count ?? 1) > 0)
    .sort((left, right) => Number(right.count ?? 1) - Number(left.count ?? 1)).slice(0, MAX_GENRES).map((genre) => genreName(genre.name))
}

/** Up to two moods from tag lists, the most voted first. */
export function moodsFromTags(tags) {
  const votes = new Map()
  for (const tag of tags ?? []) {
    const mood = moodOf.get(text(tag?.name).toLowerCase())
    if (mood) votes.set(mood, (votes.get(mood) ?? 0) + Math.max(1, Number(tag.count) || 1))
  }
  return [...votes].sort((left, right) => right[1] - left[1]).slice(0, MAX_MOODS).map(([mood]) => mood[0].toUpperCase() + mood.slice(1))
}

/** The ffmpeg arguments that copy a file with the new tags added; everything else, audio and tags, is copied as is. */
export function styleWriteArguments(file, output, style) {
  const format = STYLE_FORMATS[extname(file).toLowerCase()]
  const flag = format.stream ? '-metadata:s:a:0' : '-metadata'
  const values = [
    [format.bpm, style.bpm ? String(Math.round(style.bpm)) : null],
    [format.genre, style.genres?.length ? style.genres.join('; ') : null],
    [format.mood, style.moods?.length ? style.moods.join('; ') : null],
    [format.checked, style.checked ? style.checked : null],
  ].filter(([key, value]) => key && value)
  return [
    '-v', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', '-map_metadata', '0',
    ...(format.stream ? ['-map_metadata:s:a:0', '0:s:a:0'] : []),
    ...values.flatMap(([key, value]) => [flag, `${key}=${value}`]),
    output,
  ]
}

function collect(child, timeoutMs, kill = [child]) {
  return new Promise((resolvePromise, reject) => {
    const stdout = []
    let stderr = ''
    const timer = setTimeout(() => { for (const running of kill) running.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(Buffer.concat(stdout))
      else reject(new Error(stderr.trim().split('\n').pop() || (signal ? `killed by ${signal}` : `exit ${code}`)))
    })
  })
}

function createMusicBrainz({ fetcher, sleep, now }) {
  let next = 0
  const cache = new Map()
  async function get(path, attempt = 0) {
    const wait = next - now()
    next = Math.max(now(), next) + 1100
    if (wait > 0) await sleep(wait)
    const response = await fetcher(`https://musicbrainz.org/ws/2/${path}`, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
    if (response.status === 404) return null
    if (response.status === 503 && attempt === 0) { await sleep(2000); return get(path, 1) }
    if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}`)
    return path.includes('fmt=txt') ? response.text() : response.json()
  }
  // Release groups and artists repeat across an album, so their answers are kept for the agent's lifetime.
  async function cached(path) {
    if (!cache.has(path)) {
      if (cache.size > 2000) cache.clear()
      cache.set(path, get(path).catch((error) => { cache.delete(path); throw error }))
    }
    return cache.get(path)
  }
  return { get, cached }
}

/**
 * Turned on by BPM_PATH (tempo) and STYLE_LOOKUP=on (genre and mood; LASTFM_API_KEY adds Last.fm's tags, the main
 * source of moods). tagFile adds what one file is missing; the returned function tags an import's staged
 * derivatives. Neither throws.
 */
export function createStyleTagger({
  bpm = process.env.BPM_PATH || '',
  lookup = /^(1|on|true|yes)$/i.test(process.env.STYLE_LOOKUP || ''),
  lastfmKey = process.env.LASTFM_API_KEY || '',
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe = process.env.FFPROBE_PATH || 'ffprobe',
  spawn = nodeSpawn, fetcher = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now,
  log = (message) => process.stderr.write(`${message}\n`), timeoutMs = 5 * 60_000, today = () => new Date().toISOString().slice(0, 10),
} = {}) {
  let bpmMissing = false
  const musicBrainz = createMusicBrainz({ fetcher, sleep, now })
  let genreList = null
  let lastfmNext = 0

  async function probe(file) {
    const output = await collect(spawn(ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', ffprobeTagJsonFormat, file], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), 60_000)
    return probedTags(JSON.parse(decodeToolOutput(output) || '{}'))
  }

  // ffmpeg decodes up to five minutes to mono 44.1 kHz floats and pipes them into bpm-tools' bpm, which prints the tempo.
  async function measureBpm(file) {
    const decoder = spawn(ffmpeg, ['-v', 'error', '-i', file, '-t', '300', '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const counter = spawn(bpm, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    counter.stdin.on('error', () => {})
    decoder.stdout.pipe(counter.stdin)
    const [, output] = await Promise.all([collect(decoder, timeoutMs, [decoder, counter]), collect(counter, timeoutMs, [decoder, counter])])
      .catch((error) => { decoder.kill('SIGKILL'); counter.kill('SIGKILL'); throw error })
    const tempo = Number.parseFloat(output.toString('utf8'))
    return tempo >= 40 && tempo <= 250 ? Math.round(tempo) : null
  }

  async function lastfmTags(artist, title) {
    const wait = lastfmNext - now()
    lastfmNext = Math.max(now(), lastfmNext) + 250
    if (wait > 0) await sleep(wait)
    const query = new URLSearchParams({ method: 'track.gettoptags', artist, track: title, autocorrect: '1', api_key: lastfmKey, format: 'json' })
    const response = await fetcher(`https://ws.audioscrobbler.com/2.0/?${query}`, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok) throw new Error(`Last.fm returned ${response.status}`)
    const tags = (await response.json())?.toptags?.tag
    return (Array.isArray(tags) ? tags : []).filter((tag) => Number(tag?.count) >= 10)
  }

  // MusicBrainz's own genre list, used to tell which Last.fm tags are genres.
  async function knownGenres() {
    genreList ??= musicBrainz.get('genre/all?fmt=txt').then((list) => new Set(String(list).split('\n').map((name) => name.trim().toLowerCase()).filter(Boolean))).catch(() => new Set())
    return genreList
  }

  async function findRecording(artist, title) {
    const quote = (value) => `"${value.replace(/["\\]/g, '\\$&')}"`
    const found = await musicBrainz.get(`recording?query=${encodeURIComponent(`recording:${quote(title)} AND artist:${quote(artist)}`)}&limit=5&fmt=json`)
    const match = (found?.recordings ?? []).find((recording) => Number(recording.score) >= 90 && foldName(recording.title) === foldName(title)
      && foldName((recording['artist-credit'] ?? []).map((credit) => `${credit.name ?? credit.artist?.name ?? ''}${credit.joinphrase ?? ''}`).join('')) === foldName(artist))
    return match?.id ?? null
  }

  /** Genres (MusicBrainz recording, then release group, then artist, then Last.fm) and moods for one track. */
  async function lookupStyle(known, { genres: wantGenres = true, moods: wantMoods = true } = {}) {
    const tags = []
    let genres = []
    if (wantGenres) {
      const recordingId = known.recordingId || (known.artist && known.title ? await findRecording(known.artist, known.title) : null)
      const recording = recordingId ? await musicBrainz.get(`recording/${encodeURIComponent(recordingId)}?inc=genres+tags+artist-credits&fmt=json`) : null
      genres = topGenres(recording?.genres)
      tags.push(...recording?.tags ?? [])
      if (!genres.length && known.releaseGroupId) {
        const group = await musicBrainz.cached(`release-group/${encodeURIComponent(known.releaseGroupId)}?inc=genres+tags&fmt=json`)
        genres = topGenres(group?.genres)
        tags.push(...group?.tags ?? [])
      }
      const artistId = recording?.['artist-credit']?.[0]?.artist?.id
      if (!genres.length && artistId) genres = topGenres((await musicBrainz.cached(`artist/${encodeURIComponent(artistId)}?inc=genres&fmt=json`))?.genres)
    }
    if (lastfmKey && known.artist && known.title && (wantMoods || !genres.length)) {
      const lastfm = await lastfmTags(known.artist, known.title)
      tags.push(...lastfm)
      if (wantGenres && !genres.length) {
        const list = await knownGenres()
        genres = topGenres(lastfm.filter((tag) => list.has(text(tag.name).toLowerCase()) && !moodOf.has(text(tag.name).toLowerCase())))
      }
    }
    return { genres, moods: wantMoods ? moodsFromTags(tags) : [] }
  }

  async function writeStyle(file, style) {
    const output = join(dirname(file), `.${basename(file, extname(file))}.style-${process.pid}${extname(file)}`)
    try {
      await collect(spawn(ffmpeg, styleWriteArguments(file, output, style), { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }), timeoutMs)
      await rename(output, file)
    } catch (error) {
      await rm(output, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Adds the BPM, genre and mood one file is missing. Tags it already has are never replaced. Returns what was
   * added ({ bpm, genres, moods }), or null when nothing was. With dryRun it reports without writing.
   */
  async function tagFile(file, { dryRun = false, recheck = false } = {}) {
    const format = STYLE_FORMATS[extname(file).toLowerCase()]
    if (!format || ((!bpm || bpmMissing) && !lookup)) return null
    const known = existingStyle(await probe(file))
    const style = { bpm: null, genres: [], moods: [], checked: null }
    if (!known.bpm && bpm && !bpmMissing) {
      try { style.bpm = await measureBpm(file) } catch (error) {
        if (error?.code === 'ENOENT') { bpmMissing = true; log(`BPM tagging is off: ${bpm} was not found.`) } else log(`BPM analysis failed for ${file}: ${error instanceof Error ? error.message : error}`)
      }
    }
    const wantGenres = !known.genre
    const wantMoods = Boolean(format.mood) && !known.mood && Boolean(lastfmKey || wantGenres)
    if (lookup && (wantGenres || wantMoods) && (recheck || !known.checked)) {
      try {
        Object.assign(style, await lookupStyle(known, { genres: wantGenres, moods: wantMoods }))
        style.checked = today()
      } catch (error) { log(`Genre and mood lookup failed for ${file}: ${error instanceof Error ? error.message : error}`) }
    }
    const added = { bpm: style.bpm, genres: style.genres, moods: style.moods }
    if (!added.bpm && !added.genres.length && !added.moods.length && !(style.checked && format.checked)) return null
    if (!dryRun) await writeStyle(file, style)
    return added
  }

  // An import's staged derivatives, one at a time. Returns { tagged, failed } file counts.
  async function tagStyle(entries, stagingRoot) {
    const root = resolve(stagingRoot)
    const outcome = { tagged: 0, failed: 0 }
    if ((!bpm || bpmMissing) && !lookup) return outcome
    for (const entry of entries) {
      if (entry.role !== 'derivative' || !inside(resolve(entry.source), root) || !STYLE_EXTENSIONS.has(extname(entry.source).toLowerCase())) continue
      try {
        if (await tagFile(entry.source)) outcome.tagged += 1
      } catch (error) {
        outcome.failed += 1
        log(`BPM and genre tagging failed for ${entry.destination}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return outcome
  }

  return Object.assign(tagStyle, { tagFile, lookupStyle, measureBpm })
}

let defaultTagger = null
export function defaultStyleTagger() {
  defaultTagger ??= createStyleTagger()
  return defaultTagger
}
