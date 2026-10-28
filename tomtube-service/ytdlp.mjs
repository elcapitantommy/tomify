// Running yt-dlp: the only part of TomTube that talks to YouTube's website and player API.
//
// Every argument list is built here from validated input: a search is `ytsearchN:<text>` as one
// argument, a video is `https://www.youtube.com/watch?v=<11-character id>`. yt-dlp never runs through a
// shell, its output is capped, it has a timeout, and only a few run at once. Errors are reduced to a
// code and a short message with paths, cookies and credentials removed.
import { spawn as nodeSpawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchUrl } from './ids.mjs'

export class YtDlpError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.name = 'YtDlpError'
    this.code = code
    this.status = status
  }
}

// [pattern, code, HTTP status, message shown to the listener]
const FAILURES = [
  [/private video/i, 'private', 403, 'This video is private.'],
  [/sign in to confirm your age|age[- ]restricted|inappropriate for some users/i, 'age-restricted', 403, 'This video is age-restricted. TomTube needs a signed-in YouTube cookie file to play it.'],
  [/members[- ]only|join this channel/i, 'members-only', 403, 'This video is for channel members only.'],
  [/not a bot|confirm you.re not a robot|sign in to confirm/i, 'bot-check', 503, 'YouTube asked the server to prove it is not a bot. A PO token provider or cookie file may be needed (see docs/TOMTUBE.md).'],
  [/HTTP Error 429|too many requests/i, 'rate-limited', 503, 'YouTube is rate-limiting the server. Try again in a few minutes.'],
  [/premieres in|live event will begin|this live event/i, 'not-started', 422, 'This live stream or premiere has not started yet.'],
  [/not available in your country|geo[- ]?restrict/i, 'geo-blocked', 403, 'This video is not available in the server\'s country.'],
  [/video unavailable|this video is unavailable|has been removed|does not exist|no longer available|account associated with this video has been terminated/i, 'unavailable', 404, 'This video is unavailable.'],
  [/requested format is not available|no video formats found/i, 'no-formats', 422, 'YouTube offered no playable formats for this video.'],
  [/unable to download|timed out|connection reset|network is unreachable|temporary failure in name resolution|errno -3/i, 'network', 502, 'The server could not reach YouTube.'],
]

export function sanitizeToolOutput(value, secrets = []) {
  let text = String(value || '')
  for (const secret of secrets.filter(Boolean)) text = text.split(String(secret)).join('[redacted]')
  return text
    .replace(/--cookies(?:=|\s+)\S+/gi, '--cookies [redacted]')
    .replace(/(?:^|\s)(?:Cookie|Authorization|X-Goog-[A-Za-z-]+):[^\r\n]*/gi, ' [redacted-credential]')
    .replace(/https?:\/\/[^\s'"]*googlevideo\.com[^\s'"]*/gi, '[media-url]')
    .replace(/([?&](?:pot|sig|signature|n|lsig)=)[^&\s'"]+/gi, '$1[redacted]')
    .replace(/\/(?:opt|etc|var|home|srv)\/[^\s:'"]+/g, '[path]')
    .trim()
    .slice(-500)
}

export function classifyFailure(stderr, secrets = []) {
  const text = String(stderr || '')
  for (const [pattern, code, status, message] of FAILURES) if (pattern.test(text)) return new YtDlpError(code, message, status)
  const last = sanitizeToolOutput(text.split('\n').filter((line) => /ERROR/.test(line)).pop() || text, secrets)
  return new YtDlpError('extraction-failed', last ? `yt-dlp failed: ${last}` : 'yt-dlp failed.', 502)
}

// A queue of at most `limit` running jobs and `maxQueued` waiting ones.
export function createLimiter(limit, maxQueued = 20) {
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= limit || !waiting.length) return
    active += 1
    const { task, resolve, reject } = waiting.shift()
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; next() })
  }
  return {
    run(task) {
      if (waiting.length >= maxQueued) return Promise.reject(new YtDlpError('busy', 'TomTube is busy. Try again in a moment.', 503))
      return new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next() })
    },
    get active() { return active },
    get queued() { return waiting.length },
  }
}

// The arguments every yt-dlp call shares, from the service configuration.
export function baseArguments(config, cookieCopy = null) {
  const args = ['--ignore-config', '--no-warnings', '--no-progress', '--no-playlist', '--socket-timeout', '15']
  if (config.cacheDir) args.push('--cache-dir', config.cacheDir)
  else args.push('--no-cache-dir')
  if (config.jsRuntime) args.push('--js-runtimes', config.jsRuntime)
  if (config.remoteComponents) args.push('--remote-components', config.remoteComponents)
  if (cookieCopy) args.push('--cookies', cookieCopy)
  const youtubeArgs = []
  if (config.playerClients) youtubeArgs.push(`player_client=${config.playerClients}`)
  if (youtubeArgs.length) args.push('--extractor-args', `youtube:${youtubeArgs.join(';')}`)
  if (config.potProviderUrl) args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`)
  return args
}

export function extractArguments(config, videoId, cookieCopy = null) {
  return [...baseArguments(config, cookieCopy), '--dump-single-json', '--skip-download', '--', watchUrl(videoId)]
}

export function searchArguments(config, query, limit, cookieCopy = null) {
  return [...baseArguments(config, cookieCopy), '--flat-playlist', '--dump-single-json', '--', `ytsearch${limit}:${query}`]
}

export function createYtDlp(config, { spawn = nodeSpawn, log = () => {} } = {}) {
  const limiter = createLimiter(config.maxConcurrent, config.maxQueued)
  let versionCache = null

  function exec(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child
      try { child = spawn(config.binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } }) }
      catch (error) { reject(new YtDlpError('ytdlp-missing', `yt-dlp could not be started: ${error.code || error.message}`, 503)); return }
      const out = []
      let outBytes = 0
      let stderr = ''
      let settled = false
      const finish = (callback) => { if (!settled) { settled = true; clearTimeout(timer); callback() } }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(() => reject(new YtDlpError('timeout', 'YouTube took too long to answer.', 504))) }, timeoutMs)
      child.stdout.on('data', (chunk) => { out.push(chunk); outBytes += chunk.length; if (outBytes > config.maxOutputBytes) { child.kill('SIGKILL'); finish(() => reject(new YtDlpError('extraction-failed', 'yt-dlp returned too much data.', 502))) } })
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20_000) })
      child.on('error', (error) => finish(() => reject(error.code === 'ENOENT' ? new YtDlpError('ytdlp-missing', 'yt-dlp is not installed on the server (TOMTUBE_YTDLP_PATH).', 503) : new YtDlpError('extraction-failed', `yt-dlp could not run: ${error.code || 'error'}`, 502))))
      child.on('close', (code) => finish(() => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
        else {
          const failure = classifyFailure(stderr, [config.cookies])
          log(`yt-dlp exited ${code}: ${failure.code}: ${sanitizeToolOutput(stderr, [config.cookies]).split('\n').pop()}`)
          reject(failure)
        }
      }))
    })
  }

  // yt-dlp writes its cookie jar back to the file it was given, so it gets a private copy each time.
  async function withCookies(task) {
    if (!config.cookies) return task(null)
    const dir = await mkdtemp(join(tmpdir(), 'tomtube-cookies-'))
    const copy = join(dir, 'cookies.txt')
    try {
      await copyFile(config.cookies, copy)
      return await task(copy)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }

  function parse(stdout) {
    try { return JSON.parse(stdout) } catch { throw new YtDlpError('extraction-failed', 'yt-dlp returned unreadable output.', 502) }
  }

  return {
    limiter,
    extract: (videoId) => limiter.run(() => withCookies((cookies) => exec(extractArguments(config, videoId, cookies), config.timeoutMs))).then(parse),
    search: (query, limit) => limiter.run(() => withCookies((cookies) => exec(searchArguments(config, query, limit, cookies), config.timeoutMs))).then(parse),
    async version() {
      if (versionCache && Date.now() - versionCache.at < 3600_000) return versionCache.value
      let value = null
      try { value = (await exec(['--version'], 10_000)).trim().slice(0, 40) || null } catch { value = null }
      versionCache = { at: Date.now(), value }
      return value
    },
  }
}
