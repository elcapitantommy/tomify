// TomTube's own recommendation model. It learns all the time from what is watched in TomTube, and,
// while a cookies.txt from Tom's YouTube account works, also from the account's history, subscriptions
// and recommendations. There is no fixed training period: when the cookies expire the model simply
// carries on with what it has, and renewing them adds to it again without resetting anything.
//
// Signals and their weight (channelAffinity). What YouTube recommends is never taken as a like:
//   finished a video ............ strong positive      watched most of a video ...... positive
//   watched a channel repeatedly  strong positive      subscribed ................... positive
//   in the YouTube history ...... positive             skipped after a few seconds .. weak negative
//   "Not interested" ............ strong negative (the video is never shown again)
//   YouTube recommended it ...... discovery only: a channel recommended again and again is suggested
//                                 to try, but never counted as liked
//
// Suggestions, all without channels he has rejected:
//   - YouTube's own recommendations from the last sync, while that is less than two days old;
//   - new uploads from the channels he likes most, from each channel's public RSS feed;
//   - channels YouTube recommended again and again that he hasn't watched yet;
//   - searches for topics that recur in the titles of videos he finished or mostly watched.
//
// The cookies are the account's sign-in, so they are kept apart from everything else: only
// youtube.com cookies are kept, encrypted (AES-256-GCM, key from TOMTUBE_TRAINING_KEY or derived from
// TOMTUBE_TOKEN) in a mode-700 secrets folder; they are used only for these metadata reads, at most a
// few times a day, never for playback or search (those stay unauthenticated); they are decrypted only
// into a private temporary file for each yt-dlp run; and they are never logged or sent back to the
// phone: the API reports only whether they work, when they were added and when they expire.
//
// Each Tomify account has its own profile: its own watches, skips, "Not interested", imported history,
// subscriptions and recommendations, in training/users/<account>/log.json, so one listener's viewing
// never shapes another's suggestions. Only an account owner (TOMTUBE_TRAINING_USERS in the Worker,
// passed on as x-tomtube-owner) can add cookies or sync, so only an owner's profile imports from a
// signed-in YouTube account. The server-wide log from before profiles is moved to the first owner who
// opens TomTube.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isVideoId } from './ids.mjs'
import { searchResult } from './formats.mjs'
import { fetchAllowed } from './upstream.mjs'
import { FEEDS } from './ytdlp.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR
const MAX_COOKIE_BYTES = 256 * 1024
const MAX_FEED_BYTES = 1024 * 1024
const AUTH_COOKIES = ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID']
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
const LIMITS = { watches: 3000, youtubeHistory: 3000, subscriptions: 1000, recommendedChannels: 500, recommendedVideos: 60 }
const FEED_SIZES = { history: 200, subscriptions: 100, recommended: 60 }
const RECOMMENDATIONS_TTL_MS = HOUR
const CHANNEL_FEED_TTL_MS = HOUR
// A manual sync is refused this soon after the last one, so YouTube sees few signed-in requests.
const MIN_SYNC_GAP_MS = 15 * 60_000
const SKIP_SECONDS = 15

// Signal weights for channelAffinity (see the table at the top of this file).
export const WEIGHTS = Object.freeze({ finished: 3, most: 1.5, partial: 0.3, skipped: -0.5, repeatBonus: 1, repeatBonusMax: 4, subscribed: 2, youtubeHistory: 1, notInterested: -4 })

// --- encryption at rest -----------------------------------------------------------------------------

const ENCRYPTED_PREFIX = 'TTC1:'

export function cookieKey(secret) {
  if (!secret) return null
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('tomtube'), Buffer.from('training-cookies-v1'), 32))
}

export function encryptCookies(text, key) {
  if (!key) return text
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}\n`
}

export function decryptCookies(stored, key) {
  const value = String(stored || '').trim()
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  if (!key) throw new TrainingError(500, 'cookies-unreadable', 'The stored cookies are encrypted and no key is configured.')
  const raw = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch { throw new TrainingError(500, 'cookies-unreadable', 'The stored cookies could not be decrypted (was the key changed?). Add them again.') }
}

export class TrainingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

// --- cookies --------------------------------------------------------------------------------------

function isYouTubeDomain(domain) {
  const host = String(domain || '').toLowerCase().replace(/^#httponly_/, '').replace(/^\./, '')
  return host === 'youtube.com' || host.endsWith('.youtube.com')
}

// A browser extension's JSON export (an array of { domain, name, value, path, secure, expirationDate }).
function jsonToNetscape(cookies) {
  if (!Array.isArray(cookies)) return null
  return cookies.filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string').map((cookie) => {
    const domain = cookie.domain.startsWith('.') || cookie.hostOnly === false ? `.${cookie.domain.replace(/^\./, '')}` : cookie.domain
    const expires = Math.floor(Number(cookie.expirationDate ?? cookie.expires ?? 0)) || 0
    return [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', String(Math.max(0, expires)), cookie.name, cookie.value].join('\t')
  }).join('\n')
}

// A pasted or uploaded cookies.txt (Netscape format, or a JSON export) → the youtube.com cookies as a
// Netscape file, and when the account's sign-in cookies expire. Throws when it can't sign in.
export function parseCookieFile(input, now = Date.now()) {
  let text = String(input ?? '')
  if (Buffer.byteLength(text) > MAX_COOKIE_BYTES) throw new TrainingError(413, 'cookies-too-large', 'That cookie file is too large.')
  text = text.replace(/^﻿/, '').trim()
  if (text.startsWith('[')) {
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* not JSON after all */ }
    const converted = jsonToNetscape(parsed)
    if (converted !== null) text = converted
  }
  const kept = []
  const values = []
  let authExpires = null
  let auth = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || (line.startsWith('#') && !/^#HttpOnly_/i.test(line))) continue
    const fields = line.split('\t')
    if (fields.length !== 7) continue
    const [domain, , path, , expires, name, value] = fields
    if (!isYouTubeDomain(domain) || !name || !path.startsWith('/') || /[\r\n]/.test(value)) continue
    const expiry = Number(expires)
    if (!Number.isFinite(expiry) || expiry < 0) continue
    // Already expired cookies are dropped; 0 means a session cookie.
    if (expiry > 0 && expiry * 1000 < now) continue
    kept.push(fields.join('\t'))
    if (value.length >= 8) values.push(value)
    if (AUTH_COOKIES.includes(name)) {
      auth = true
      if (expiry > 0) authExpires = authExpires === null ? expiry * 1000 : Math.min(authExpires, expiry * 1000)
    }
  }
  if (!kept.length) throw new TrainingError(400, 'invalid-cookies', 'No youtube.com cookies were found. Export cookies.txt (Netscape format) while signed in to youtube.com.')
  if (!auth) throw new TrainingError(400, 'cookies-not-signed-in', 'These cookies are not signed in to YouTube (no SAPISID cookie). Sign in to youtube.com in the browser first, then export again.')
  return {
    file: `# Netscape HTTP Cookie File\n# youtube.com cookies for TomTube's recommendations. Do not share.\n${kept.join('\n')}\n`,
    expiresAt: authExpires ? new Date(authExpires).toISOString() : null,
    count: kept.length,
    values,
  }
}

// A yt-dlp failure or warning that means the account is signed out (cookies expired or rotated).
export function isSignedOut(text, code = null) {
  if (code === 'bot-check' || code === 'rate-limited' || code === 'network' || code === 'timeout') return false
  return /cookies are no longer valid|cookies? (?:have|has) (?:expired|been rotated)|requires? (?:authentication|login|an account)|login required|need to log ?in|only available for registered users|use --cookies|sign in to (?:view|see|continue)|not signed in/i.test(String(text || ''))
}

// --- channel feeds and topics ---------------------------------------------------------------------

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim()
}

// A channel's https://www.youtube.com/feeds/videos.xml?channel_id=… → its latest uploads (about 15).
export function parseChannelFeed(xml) {
  const text = String(xml || '')
  const channel = decodeXml(/<author>\s*<name>([^<]*)<\/name>/.exec(text.split('<entry>')[0])?.[1])
  return text.split('<entry>').slice(1).map((chunk) => {
    const id = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(chunk)?.[1]
    if (!id) return null
    const channelId = /<yt:channelId>(UC[A-Za-z0-9_-]{22})<\/yt:channelId>/.exec(chunk)?.[1] ?? null
    const published = Date.parse(/<published>([^<]+)<\/published>/.exec(chunk)?.[1] || '')
    return {
      id,
      title: decodeXml(/<title>([^<]*)<\/title>/.exec(chunk)?.[1]) || 'Untitled',
      channel: decodeXml(/<author>\s*<name>([^<]*)<\/name>/.exec(chunk)?.[1]) || channel,
      channelId,
      duration: null,
      viewCount: Number(/<media:statistics views="(\d+)"/.exec(chunk)?.[1]) || null,
      isLive: false,
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    }
  }).filter(Boolean)
}

const STOPWORDS = new Set(`a about after all also an and any are as at be been before being best but by can could did do does
doing don down during each every few for from get got had has have how i if in into is it its just like make more most my new
no not now of off official on one only or other our out over own same she should so some such than that the their them then there
these they this those through to too under until up very via was we were what when where which while who why will with would you
your vs ft feat featuring video videos music audio lyric lyrics hd 4k 1080p full version remix remastered live trailer teaser shorts
short episode ep part pt official clip clips highlights reaction review update day week vlog explained watch first last ever
year years time way part1 part2 la le de el en der die das und mit`.split(/\s+/))

function words(title) {
  return String(title || '').toLowerCase().normalize('NFKC')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter(Boolean)
}

// Topics that recur in the titles of finished videos: two-word phrases first, then single words.
export function topicPhrases(titles, max = 3) {
  const pairs = new Map()
  const singles = new Map()
  for (const title of new Set(titles)) {
    const tokens = words(title)
    // Two-letter words count only inside a phrase ("raspberry pi").
    const keep = (word) => word.length >= 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word)
    const seenPairs = new Set()
    const seenSingles = new Set()
    tokens.forEach((word, index) => {
      if (!keep(word)) return
      if (word.length >= 3) seenSingles.add(word)
      const following = tokens[index + 1]
      if (following && keep(following) && following !== word) seenPairs.add(`${word} ${following}`)
    })
    for (const pair of seenPairs) pairs.set(pair, (pairs.get(pair) || 0) + 1)
    for (const word of seenSingles) singles.set(word, (singles.get(word) || 0) + 1)
  }
  const ranked = (map) => [...map].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([phrase]) => phrase)
  const chosen = []
  for (const phrase of ranked(pairs)) if (chosen.length < max) chosen.push(phrase)
  for (const word of ranked(singles)) {
    if (chosen.length >= max) break
    if (!chosen.some((phrase) => phrase.split(' ').includes(word))) chosen.push(word)
  }
  return chosen
}

const decay = (at, now, halfLifeDays) => 0.5 ** (Math.max(0, now - (Number(at) || now)) / (halfLifeDays * DAY))

// How engaged one TomTube watch was: finished, mostly watched, partly watched or skipped.
export function watchKind(watch) {
  if (watch.finished) return 'finished'
  const seconds = Number(watch.seconds) || 0
  const duration = Number(watch.duration) || 0
  if (duration && seconds >= duration * 0.5) return 'most'
  if (watch.skipped && seconds < SKIP_SECONDS) return 'skipped'
  return seconds >= 10 ? 'partial' : 'skipped'
}

// How much Tom likes each channel, from the signals in the table at the top of this file. Older
// signals count less (90-day half-life). Recommendations from YouTube are not part of this.
export function channelAffinity(data, now = Date.now()) {
  const channels = new Map()
  const get = (channelId, channel) => {
    if (!CHANNEL_ID.test(String(channelId || ''))) return null
    const entry = channels.get(channelId) || { channelId, channel: channel || '', score: 0, watched: false, subscribed: false, engaged: 0, rejected: false }
    if (!entry.channel && channel) entry.channel = channel
    channels.set(channelId, entry)
    return entry
  }
  for (const watch of Object.values(data.watches || {})) {
    const entry = get(watch.channelId, watch.channel)
    if (!entry) continue
    const kind = watchKind(watch)
    const plays = Math.min(3, Math.max(1, watch.plays || 1))
    entry.score += WEIGHTS[kind] * (kind === 'skipped' ? 1 : plays) * decay(watch.lastAt, now, 90)
    if (kind === 'finished' || kind === 'most') { entry.engaged += 1; entry.watched = true }
    if (kind === 'partial') entry.watched = true
  }
  for (const item of Object.values(data.youtubeHistory || {})) {
    const entry = get(item.channelId, item.channel)
    if (!entry) continue
    entry.score += WEIGHTS.youtubeHistory * decay(item.seenAt, now, 90)
    entry.engaged += 1
    entry.watched = true
  }
  // Watching a channel again and again is a strong positive on top of each watch.
  for (const entry of channels.values()) if (entry.engaged > 1) entry.score += Math.min(WEIGHTS.repeatBonusMax, (entry.engaged - 1) * WEIGHTS.repeatBonus)
  for (const item of Object.values(data.subscriptions || {})) {
    const entry = get(item.channelId, item.channel)
    if (!entry) continue
    entry.score += WEIGHTS.subscribed
    entry.subscribed = true
  }
  for (const item of Object.values(data.notInterested || {})) {
    const entry = get(item.channelId, item.channel)
    if (!entry) continue
    entry.score += WEIGHTS.notInterested * decay(item.at, now, 180)
    entry.rejected = true
  }
  return [...channels.values()].sort((a, b) => b.score - a.score || a.channel.localeCompare(b.channel))
}

// --- the log ----------------------------------------------------------------------------------------

function emptyData() {
  return { version: 1, owner: false, watches: {}, notInterested: {}, youtubeHistory: {}, subscriptions: {}, recommended: { videos: [], syncedAt: null }, recommendedChannels: {}, cookies: { state: 'missing', updatedAt: null, expiresAt: null, lastSyncAt: null, lastSuccessAt: null, lastError: null } }
}

function cap(map, limit, field) {
  const entries = Object.entries(map)
  if (entries.length <= limit) return map
  return Object.fromEntries(entries.sort((a, b) => (Number(b[1][field]) || 0) - (Number(a[1][field]) || 0)).slice(0, limit))
}

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)

// A flat feed entry's channel id: channel_id, or the UC… id in its channel or uploader URL.
export function channelIdOf(entry) {
  for (const value of [entry?.channel_id, entry?.uploader_id, entry?.channel_url, entry?.uploader_url]) {
    const match = /(?:^|\/channel\/)(UC[A-Za-z0-9_-]{22})(?:$|[/?#])/.exec(String(value || ''))
    if (match) return match[1]
  }
  return null
}

function feedVideos(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : []
  return entries.map((entry) => {
    const video = searchResult(entry)
    if (video && !video.channelId) video.channelId = channelIdOf(entry)
    return video
  }).filter(Boolean)
}

const REPORTS_KEPT = 5
const BACKFILL_PER_SYNC = 10

// What one account feed returned, for checking the import against real YouTube: how many entries,
// how many became usable videos, what was missing or dropped, and the shapes seen. It holds field
// names, counts and a few of the account's own titles, never cookies.
export function inspectFeed(feed, result, { warnings = '', ms = 0 } = {}) {
  const raw = Array.isArray(result?.entries) ? result.entries : null
  const entries = raw || []
  const videos = feedVideos(result)
  const count = (list, pick) => Object.entries(list.reduce((totals, item) => { const key = String(pick(item) ?? 'none'); totals[key] = (totals[key] || 0) + 1; return totals }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const fields = new Map()
  for (const entry of entries.slice(0, 20)) for (const key of Object.keys(entry || {})) fields.set(key, (fields.get(key) || 0) + 1)
  return {
    feed,
    ok: true,
    ms,
    shape: { type: result?._type ?? null, extractor: result?.extractor_key ?? null, hasEntries: Boolean(raw) },
    entries: entries.length,
    videos: videos.length,
    dropped: entries.length - videos.length,
    droppedKinds: count(entries.filter((entry) => !searchResult(entry)), (entry) => entry?.ie_key || entry?._type || typeof entry),
    missing: {
      channelId: videos.filter((video) => !video.channelId).length,
      channel: videos.filter((video) => !video.channel).length,
      title: videos.filter((video) => video.title === 'Untitled').length,
      duration: videos.filter((video) => !video.duration).length,
    },
    channels: new Set(videos.map((video) => video.channelId).filter(Boolean)).size,
    fields: [...fields].sort((a, b) => b[1] - a[1]).map(([key]) => key).slice(0, 25),
    sample: videos.slice(0, 3).map(({ id, title, channel, channelId }) => ({ id, title, channel, channelId })),
    warnings: String(warnings || '').split('\n').map((line) => line.trim()).filter((line) => /WARNING|ERROR/.test(line)).slice(0, 3),
  }
}

// Plain-language problems in one sync's import, worst first.
export function importProblems(report) {
  const problems = []
  for (const feed of report.feeds) {
    if (!feed.ok) { problems.push(`${feed.feed}: failed (${feed.code}${feed.signedOut ? ', signed out' : ''})`); continue }
    if (!feed.shape.hasEntries) problems.push(`${feed.feed}: unexpected structure (no entries list; type ${feed.shape.type || 'none'})`)
    else if (!feed.entries) problems.push(`${feed.feed}: returned nothing`)
    if (feed.entries && feed.dropped / feed.entries > 0.2) problems.push(`${feed.feed}: ${feed.dropped} of ${feed.entries} entries were not usable videos`)
    const unresolved = feed.missing.channelId - (feed.backfilled || 0)
    if (feed.videos && unresolved / feed.videos > 0.1) problems.push(`${feed.feed}: ${unresolved} of ${feed.videos} videos have no channel ID${feed.backfilled ? ` (${feed.backfilled} looked up)` : ''}`)
    if (feed.warnings.length) problems.push(`${feed.feed}: yt-dlp warned: ${feed.warnings[0]}`)
  }
  return problems
}


// A Tomify username → the name of its profile folder and cookie file. Plain usernames are kept as they
// are (lower case) so the folders are easy to find; anything else becomes a hash.
export function profileName(user) {
  const name = String(user ?? '').trim().toLowerCase()
  if (!name) return null
  if (/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) return name
  return `h-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`
}

const exists = (path) => stat(path).then(() => true, () => false)

// All the profiles on the box. `forUser` gives one account's profile; `start` syncs every owner
// profile that has cookies.
export function createTraining({ stateDir, ytdlp, lookupChannel = null, secret = null, fetch = globalThis.fetch, now = Date.now, log = () => {}, syncIntervalMs = 6 * HOUR, search = null, feedPauseMs = 5000 }) {
  const key = cookieKey(secret)
  const usersDir = join(stateDir, 'training', 'users')
  const cookiesDir = join(stateDir, 'secrets', 'users')
  const legacy = { dataFile: join(stateDir, 'training', 'log.json'), cookieFile: join(stateDir, 'secrets', 'youtube-training.cookies') }
  // Public channel RSS feeds are the same for everyone, so they are cached once.
  const channelFeeds = new Map()
  const profiles = new Map()
  let adopting = null
  let timer = null

  const paths = (name) => ({ dir: join(usersDir, name), dataFile: join(usersDir, name, 'log.json'), cookieFile: join(cookiesDir, `${name}.cookies`) })

  function profile(name) {
    if (!profiles.has(name)) profiles.set(name, createProfile({ ...paths(name), stateDir, key, ytdlp, lookupChannel, fetch, now, log, syncIntervalMs, search, feedPauseMs, channelFeeds }))
    return profiles.get(name)
  }

  // The log and cookies from before profiles existed belong to the owner: they move to the first owner
  // profile that is opened, unless it already has its own.
  async function adoptLegacy(name) {
    const target = paths(name)
    for (const [from, to, folder] of [[legacy.dataFile, target.dataFile, target.dir], [legacy.cookieFile, target.cookieFile, cookiesDir]]) {
      if (!(await exists(from)) || await exists(to)) continue
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await chmod(folder, 0o700).catch(() => undefined)
      await rename(from, to)
      log(`TomTube training: moved the shared ${from === legacy.dataFile ? 'log' : 'cookies'} to the profile of an owner`)
    }
  }

  // One account's profile. `owner` says whether this account may import from a signed-in YouTube
  // account (the Worker decides, from TOMTUBE_TRAINING_USERS).
  async function forUser(user, { owner = false } = {}) {
    const name = profileName(user)
    if (!name) throw new TrainingError(400, 'no-profile', 'Recommendations need a Tomify account.')
    if (owner && !profiles.has(name)) {
      adopting = (adopting || Promise.resolve()).then(() => adoptLegacy(name)).catch((error) => log(`TomTube training: the shared log could not be moved: ${error.code || error.message}`))
      await adopting
    }
    const chosen = profile(name)
    await chosen.setOwner(Boolean(owner))
    return chosen
  }

  // Every 30 minutes, syncs each owner profile whose cookies are due, one after another.
  function start() {
    const tick = async () => {
      let names = []
      try { names = (await readdir(cookiesDir)).filter((file) => file.endsWith('.cookies')).map((file) => file.slice(0, -'.cookies'.length)) } catch { return }
      for (const name of names) {
        try { await profile(name).syncIfDue() } catch (error) { log(`TomTube training sync failed: ${error.message}`) }
      }
    }
    const first = setTimeout(tick, 60_000)
    first.unref?.()
    timer = setInterval(tick, 30 * 60_000)
    timer.unref?.()
    return () => { clearTimeout(first); clearInterval(timer) }
  }

  return { forUser, start, profileName, paths: (user) => paths(profileName(user)) }
}

function createProfile({ dir, dataFile, cookieFile, key, ytdlp, lookupChannel, fetch, now, log, syncIntervalMs, search, feedPauseMs, channelFeeds }) {
  const secretsDir = dirname(cookieFile)
  let data = null
  let writing = Promise.resolve()
  let syncing = null
  let cookieValues = []
  let recommendationCache = null
  let computing = null

  async function load() {
    if (data) return data
    try {
      const parsed = JSON.parse(await readFile(dataFile, 'utf8'))
      data = { ...emptyData(), ...parsed, cookies: { ...emptyData().cookies, ...parsed.cookies } }
    } catch { data = emptyData() }
    try { cookieValues = parseCookieFile(await readCookies(), now()).values }
    catch { cookieValues = []; if (data.cookies.state !== 'missing' && !(await hasCookies())) data.cookies.state = 'missing' }
    return data
  }

  async function hasCookies() {
    try { await readFile(cookieFile); return true } catch { return false }
  }

  // Writes are atomic and one at a time.
  function save() {
    const snapshot = JSON.stringify(data)
    writing = writing.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temporary = `${dataFile}.${process.pid}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, dataFile)
    }).catch((error) => log(`TomTube training log could not be saved: ${error.code || error.message}`))
    return writing
  }

  async function readCookies() {
    return decryptCookies(await readFile(cookieFile, 'utf8'), key)
  }

  async function writeCookies(file) {
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    for (const folder of [dirname(secretsDir), secretsDir]) await chmod(folder, 0o700).catch(() => undefined)
    const temporary = `${cookieFile}.${process.pid}.tmp`
    await writeFile(temporary, encryptCookies(file, key), { mode: 0o600 })
    await rename(temporary, cookieFile)
  }

  // Nothing from the cookie file may end up in a stored or returned message.
  function redact(message) {
    let value = String(message || '').slice(0, 400)
    for (const secret of cookieValues) value = value.split(secret).join('[redacted]')
    return value.split(cookieFile).join('[cookie file]')
  }

  function nextSyncAt() {
    const { state, lastSyncAt } = data.cookies
    if (state === 'missing' || state === 'expired') return null
    return new Date((lastSyncAt ? Date.parse(lastSyncAt) : now()) + syncIntervalMs).toISOString()
  }

  // Recorded on every request, so a profile stops syncing once its account is no longer an owner.
  async function setOwner(owner) {
    await load()
    if (data.owner === owner) return
    data.owner = owner
    await save()
  }

  function needOwner() {
    if (!data.owner) throw new TrainingError(403, 'training-forbidden', 'Only the account owner can use YouTube account cookies.')
  }

  async function status() {
    await load()
    const affinity = channelAffinity(data, now())
    const watches = Object.values(data.watches)
    return {
      cookies: {
        state: syncing ? 'checking' : data.cookies.state,
        updatedAt: data.cookies.updatedAt,
        expiresAt: data.cookies.expiresAt,
        lastSyncAt: data.cookies.lastSyncAt,
        lastSuccessAt: data.cookies.lastSuccessAt,
        lastError: data.cookies.lastError,
        nextSyncAt: nextSyncAt(),
        encrypted: Boolean(key),
      },
      learned: {
        watches: watches.length,
        finished: watches.filter((watch) => watch.finished).length,
        skipped: watches.filter((watch) => watchKind(watch) === 'skipped').length,
        notInterested: Object.keys(data.notInterested || {}).length,
        youtubeHistory: Object.keys(data.youtubeHistory).length,
        subscriptions: Object.keys(data.subscriptions).length,
        channels: affinity.filter((entry) => entry.score > 0).length,
        recommendedChannels: Object.keys(data.recommendedChannels).length,
        recommendedSyncedAt: data.recommended.syncedAt,
      },
      syncIntervalHours: Math.round(syncIntervalMs / HOUR * 10) / 10,
      // Whether this account may add YouTube cookies (only owners can).
      youtubeAccount: Boolean(data.owner),
      lastImport: data.importReports?.[0] ? { at: data.importReports[0].at, problems: data.importReports[0].problems, feeds: data.importReports[0].feeds.map((feed) => ({ feed: feed.feed, ok: feed.ok, videos: feed.videos ?? 0, channels: feed.channels ?? 0 })) } : null,
    }
  }

  // --- syncing the account's feeds ---------------------------------------------------------------

  // The current sync's import report (see inspectFeed).
  let report = null

  async function readFeed(feed, limit) {
    const started = now()
    let result
    try { result = await ytdlp.feed(feed, limit, await readCookies()) }
    catch (error) {
      report?.feeds.push({ feed, ok: false, ms: now() - started, code: error.code || 'error', signedOut: isSignedOut(`${error.message}\n${error.detail || ''}`, error.code), message: redact(error.message) })
      throw error
    }
    report?.feeds.push(inspectFeed(feed, result.data, { warnings: redact(result.warnings), ms: now() - started }))
    if (isSignedOut(result.warnings)) throw Object.assign(new Error('YouTube says the cookies are no longer valid.'), { code: 'cookies-expired' })
    // yt-dlp keeps the jar current as YouTube rotates cookies; keep that copy if it is still signed in.
    if (result.jar) {
      try {
        const fresh = parseCookieFile(result.jar, now())
        await writeCookies(fresh.file)
        cookieValues = fresh.values
        if (fresh.expiresAt) data.cookies.expiresAt = fresh.expiresAt
      } catch { /* keep the file we had */ }
    }
    return feedVideos(result.data)
  }

  async function runSync() {
    await load()
    if (!(await hasCookies())) {
      data.cookies.state = 'missing'
      await save()
      return
    }
    const at = new Date(now()).toISOString()
    data.cookies.lastSyncAt = at
    report = { at, feeds: [] }
    try {
      // History first: it needs a signed-in account, so it tells whether the cookies still work.
      const history = await readFeed(FEEDS.history, FEED_SIZES.history)
      await backfillChannels(history, report.feeds.at(-1))
      const stamp = now()
      for (const video of history) {
        const known = data.youtubeHistory[video.id]
        data.youtubeHistory[video.id] = { id: video.id, title: video.title, channel: video.channel, channelId: video.channelId, duration: video.duration, seenAt: known?.seenAt ?? stamp }
      }
      data.youtubeHistory = cap(data.youtubeHistory, LIMITS.youtubeHistory, 'seenAt')
      data.cookies.state = 'valid'
      data.cookies.lastError = null
      data.cookies.lastSuccessAt = at

      const pause = () => new Promise((resolve) => setTimeout(resolve, feedPauseMs))
      // The others are best effort, a few seconds apart.
      await pause()
      try {
        const subscriptions = await readFeed(FEEDS.subscriptions, FEED_SIZES.subscriptions)
        await backfillChannels(subscriptions, report.feeds.at(-1))
        for (const video of subscriptions) {
          if (video.channelId) data.subscriptions[video.channelId] = { channelId: video.channelId, channel: video.channel, seenAt: stamp }
        }
        data.subscriptions = cap(data.subscriptions, LIMITS.subscriptions, 'seenAt')
      } catch (error) { data.cookies.lastError = { code: error.code || 'error', message: redact(error.message), at } }
      await pause()
      try {
        const recommended = await readFeed(FEEDS.recommended, FEED_SIZES.recommended)
        data.recommended = { videos: recommended.slice(0, LIMITS.recommendedVideos), syncedAt: at }
        for (const channelId of new Set(recommended.map((video) => video.channelId).filter(Boolean))) {
          const video = recommended.find((item) => item.channelId === channelId)
          const known = data.recommendedChannels[channelId]
          data.recommendedChannels[channelId] = { channelId, channel: video.channel, count: (known?.count || 0) + 1, lastSeen: stamp }
        }
        data.recommendedChannels = cap(data.recommendedChannels, LIMITS.recommendedChannels, 'lastSeen')
      } catch (error) { data.cookies.lastError = { code: error.code || 'error', message: redact(error.message), at } }
      recommendationCache = null
      log(`TomTube training sync: ${history.length} history, ${Object.keys(data.subscriptions).length} subscribed channels, ${data.recommended.videos.length} recommended`)
    } catch (error) {
      const expired = error.code === 'cookies-expired' || isSignedOut(`${error.message}\n${error.detail || ''}`, error.code)
      if (expired) data.cookies.state = 'expired'
      else if (data.cookies.state !== 'valid') data.cookies.state = 'error'
      data.cookies.lastError = { code: expired ? 'cookies-expired' : (error.code || 'error'), message: expired ? 'YouTube no longer accepts these cookies. Upload new ones in Settings to keep learning.' : redact(error.message), at }
      log(`TomTube training sync failed: ${data.cookies.lastError.code}`)
    }
    report.problems = importProblems(report)
    data.importReports = [report, ...(data.importReports || [])].slice(0, REPORTS_KEPT)
    if (report.problems.length) log(`TomTube import problems: ${report.problems.join('; ')}`)
    report = null
    await save()
  }

  // Videos whose feed entry had no channel id get one from an ordinary (signed-out) lookup of the
  // video, a few per sync, so history and subscriptions still count towards their channels.
  async function backfillChannels(videos, feedReport) {
    if (!lookupChannel) return
    let looked = 0
    for (const video of videos) {
      if (video.channelId || looked >= BACKFILL_PER_SYNC) continue
      looked += 1
      try {
        const channelId = await lookupChannel(video.id)
        if (CHANNEL_ID.test(String(channelId || ''))) { video.channelId = channelId; if (feedReport) feedReport.backfilled = (feedReport.backfilled || 0) + 1 }
      } catch { /* left without a channel */ }
    }
  }

  async function imports() {
    await load()
    return { reports: data.importReports || [] }
  }

  // `manual` syncs (Settings → Sync now) are refused within MIN_SYNC_GAP_MS of the last one.
  async function sync({ manual = false } = {}) {
    await load()
    needOwner()
    const last = Date.parse(data.cookies.lastSyncAt || '')
    if (manual && !syncing && Number.isFinite(last) && now() - last < MIN_SYNC_GAP_MS && data.cookies.state === 'valid') return status()
    if (!syncing) syncing = runSync().finally(() => { syncing = null })
    return syncing.then(status)
  }

  async function setCookies(input) {
    await load()
    needOwner()
    const parsed = parseCookieFile(input, now())
    if (syncing) await syncing.catch(() => undefined)
    await writeCookies(parsed.file)
    cookieValues = parsed.values
    data.cookies = { ...data.cookies, state: 'checking', updatedAt: new Date(now()).toISOString(), expiresAt: parsed.expiresAt, lastError: null }
    await save()
    log(`TomTube training cookies replaced (${parsed.count} youtube.com cookies)`)
    // The caller checks them straight away (sync), so Settings can say whether they work.
  }

  async function removeCookies() {
    await load()
    if (syncing) await syncing.catch(() => undefined)
    await rm(cookieFile, { force: true })
    cookieValues = []
    data.cookies = { ...emptyData().cookies, lastSyncAt: data.cookies.lastSyncAt, lastSuccessAt: data.cookies.lastSuccessAt }
    await save()
    return status()
  }

  // Forgets what was learned. The cookies stay, so learning starts again with the next sync.
  async function clear() {
    await load()
    if (syncing) await syncing.catch(() => undefined)
    data = { ...emptyData(), owner: data.owner, cookies: data.cookies }
    recommendationCache = null
    await save()
    return status()
  }

  // "Not interested" on a suggestion: that video is never suggested again and its channel counts against.
  async function recordFeedback(body) {
    await load()
    if (!body || typeof body !== 'object' || !isVideoId(body.id) || body.kind !== 'not-interested') throw new TrainingError(400, 'invalid-feedback', 'Feedback needs a video id and kind "not-interested".')
    data.notInterested[body.id] = { id: body.id, channelId: CHANNEL_ID.test(String(body.channelId || '')) ? body.channelId : null, channel: text(body.channel, 100), title: text(body.title, 200), at: now() }
    data.notInterested = cap(data.notInterested, LIMITS.watches, 'at')
    recommendationCache = null
    await save()
    return { ok: true }
  }

  // The app reports each video watched in TomTube: how long it played, whether it reached the end, and
  // whether it was left within a few seconds (a skip).
  async function recordWatch(body) {
    await load()
    if (!body || typeof body !== 'object' || !isVideoId(body.id)) throw new TrainingError(400, 'invalid-watch', 'A watch needs a video id.')
    const stamp = now()
    const seconds = Math.max(0, Math.min(86_400, Number(body.seconds) || 0))
    const duration = Number(body.duration) > 0 ? Math.min(Number(body.duration), 7 * 86_400) : null
    const known = data.watches[body.id]
    const newPlay = !known || stamp - known.lastAt > HOUR
    const finished = Boolean(body.ended) || Boolean(duration && seconds >= duration * 0.8)
    data.watches[body.id] = {
      id: body.id,
      title: text(body.title, 200) || known?.title || 'Untitled',
      channel: text(body.channel, 100) || known?.channel || '',
      channelId: CHANNEL_ID.test(String(body.channelId || '')) ? body.channelId : known?.channelId ?? null,
      duration: duration ?? known?.duration ?? null,
      firstAt: known?.firstAt ?? stamp,
      lastAt: stamp,
      plays: (known?.plays || 0) + (newPlay ? 1 : 0),
      seconds: Math.max(known?.seconds || 0, seconds),
      finished: Boolean(known?.finished) || finished,
      // A skip counts only while the video has never been watched for longer.
      skipped: Boolean(body.skipped) && seconds < SKIP_SECONDS && !(known && (known.seconds || 0) >= SKIP_SECONDS),
    }
    data.watches = cap(data.watches, LIMITS.watches, 'lastAt')
    await save()
    return { ok: true }
  }

  // --- suggestions -------------------------------------------------------------------------------

  async function channelUploads(channelId) {
    const cached = channelFeeds.get(channelId)
    if (cached && now() - cached.at < CHANNEL_FEED_TTL_MS) return cached.videos
    let videos = []
    try {
      const response = await fetchAllowed(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { kind: 'feed', fetch, timeoutMs: 10_000 })
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length <= MAX_FEED_BYTES) videos = parseChannelFeed(body.toString('utf8'))
      } else await response.body?.cancel().catch(() => undefined)
    } catch (error) { log(`TomTube channel feed failed: ${error.code || error.name || 'error'}`) }
    channelFeeds.set(channelId, { at: now(), videos })
    return videos
  }

  async function inBatches(items, size, task) {
    const results = []
    for (let offset = 0; offset < items.length; offset += size) results.push(...await Promise.all(items.slice(offset, offset + size).map(task)))
    return results
  }

  async function compute() {
    await load()
    const stamp = now()
    const seen = new Set([...Object.keys(data.watches), ...Object.keys(data.youtubeHistory), ...Object.keys(data.notInterested || {})])
    const shown = new Set()
    const affinity = channelAffinity(data, stamp)
    // Channels he has rejected or keeps skipping are never suggested.
    const disliked = new Set(affinity.filter((entry) => entry.score < 0).map((entry) => entry.channelId))
    const take = (video, reason) => {
      if (!video || seen.has(video.id) || shown.has(video.id) || disliked.has(video.channelId)) return null
      shown.add(video.id)
      const { publishedAt, ...rest } = video
      return { ...rest, reason, ...(publishedAt ? { publishedAt } : {}) }
    }
    const shelves = []

    // 1. YouTube's own recommendations, while the last sync is recent.
    const syncedAt = Date.parse(data.recommended.syncedAt || '')
    if (Number.isFinite(syncedAt) && stamp - syncedAt < 2 * DAY) {
      const videos = data.recommended.videos.map((video) => take(video, 'Recommended on YouTube')).filter(Boolean)
      if (videos.length) shelves.push({ id: 'youtube', title: 'Recommended for you', videos })
    }

    // 2. New uploads from the channels he likes most.
    const favourites = affinity.filter((entry) => entry.score >= 1).slice(0, 8)
    const uploads = await inBatches(favourites, 4, (entry) => channelUploads(entry.channelId))
    const perChannel = favourites.map((entry, index) => uploads[index]
      .filter((video) => !video.publishedAt || stamp - Date.parse(video.publishedAt) < 45 * DAY)
      .slice(0, 4)
      .map((video) => ({ video, reason: `Because you watch ${entry.channel || video.channel}` })))
    const fromChannels = []
    for (let round = 0; round < 4; round += 1) for (const list of perChannel) if (list[round]) fromChannels.push(list[round])
    const channelVideos = fromChannels.map(({ video, reason }) => take(video, reason)).filter(Boolean).slice(0, 30)
    if (channelVideos.length) shelves.push({ id: 'channels', title: 'New from channels you watch', videos: channelVideos })

    // 3. Channels YouTube kept recommending that he hasn't watched.
    const known = new Set(affinity.filter((entry) => entry.watched || entry.subscribed || entry.rejected || entry.score < 0).map((entry) => entry.channelId))
    const candidates = Object.values(data.recommendedChannels)
      .filter((entry) => entry.count >= 2 && !known.has(entry.channelId))
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, 6)
    const discovered = await inBatches(candidates, 3, (entry) => channelUploads(entry.channelId))
    const discoverVideos = candidates.flatMap((entry, index) => discovered[index].slice(0, 2).map((video) => take(video, `YouTube suggested ${entry.channel || 'this channel'} ${entry.count} times`))).filter(Boolean)
    if (discoverVideos.length) shelves.push({ id: 'discover', title: 'Channels you might like', videos: discoverVideos })

    // 4. Topics from the titles of videos he finished or mostly watched.
    const finishedTitles = Object.values(data.watches).filter((watch) => ['finished', 'most'].includes(watchKind(watch))).sort((a, b) => b.lastAt - a.lastAt).slice(0, 200).map((watch) => watch.title)
    const topics = search ? topicPhrases(finishedTitles, 3) : []
    const topicVideos = []
    for (const topic of topics) {
      try {
        const result = await search(topic, 10)
        topicVideos.push(...feedVideos(result).filter((video) => !video.isLive).slice(0, 8).map((video) => take(video, `More about “${topic}”`)).filter(Boolean).slice(0, 6))
      } catch (error) { log(`TomTube topic search failed: ${error.code || 'error'}`) }
    }
    if (topicVideos.length) shelves.push({ id: 'topics', title: 'More like what you finish', videos: topicVideos })

    return {
      generatedAt: new Date(stamp).toISOString(),
      source: shelves.some((shelf) => shelf.id === 'youtube') ? 'youtube' : shelves.length ? 'training' : 'none',
      cookies: (await status()).cookies.state,
      topics,
      shelves,
    }
  }

  async function recommendations({ refresh = false } = {}) {
    if (!refresh && recommendationCache && now() - recommendationCache.at < RECOMMENDATIONS_TTL_MS) return recommendationCache.value
    if (!computing) {
      computing = compute()
        .then((value) => { recommendationCache = { at: now(), value }; return value })
        .finally(() => { computing = null })
    }
    return computing
  }

  // Called by the timer: syncs while the cookies work and this account is still an owner; stops once
  // YouTube says they expired.
  async function syncIfDue() {
    await load()
    const { state, lastSyncAt } = data.cookies
    if (!data.owner || state === 'missing' || state === 'expired') return
    if (lastSyncAt && now() - Date.parse(lastSyncAt) < syncIntervalMs) return
    await sync()
  }

  return { status, imports, sync, syncIfDue, setOwner, setCookies, removeCookies, clear, recordWatch, recordFeedback, recommendations, paths: { cookieFile, dataFile } }
}
