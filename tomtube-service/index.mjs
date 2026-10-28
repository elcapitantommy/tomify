// TomTube service: ad-free YouTube playback for Tomify, run on the media server as its own systemd
// unit (tomtube.service.example), separate from the recovery agent. See docs/TOMTUBE.md.
import { createServer } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { loadConfig } from './config.mjs'
import { createYtDlp } from './ytdlp.mjs'
import { createResolver } from './resolver.mjs'
import { createAudioCache } from './cache.mjs'
import { createDiagnostics, createHandler } from './server.mjs'

const log = (message) => process.stderr.write(`${message}\n`)

let config
try { config = loadConfig() }
catch (error) {
  log(`TomTube refused to start: ${error instanceof Error ? error.message : 'invalid configuration'}`)
  process.exit(1)
}

// The deploy script writes the release's Git SHA next to this file; TOMTUBE_VERSION overrides it.
const version = config.version || (await readFile(new URL('./VERSION', import.meta.url), 'utf8').catch(() => '')).trim() || null

await mkdir(config.ytdlp.cacheDir, { recursive: true })
const cache = config.cache.maxBytes > 0 ? createAudioCache({ ...config.cache, log }) : null
if (cache) {
  await mkdir(cache.dir, { recursive: true, mode: 0o700 })
  const swept = await cache.sweep({ startup: true })
  log(`TomTube audio cache: ${swept.files} files, ${Math.round(swept.bytes / 1024 / 1024)} MB (limit ${Math.round(config.cache.maxBytes / 1024 / 1024)} MB)`)
  setInterval(() => { void cache.sweep().catch((error) => log(`Audio cache sweep failed: ${error.message}`)) }, 10 * 60_000).unref()
}

const ytdlp = createYtDlp(config.ytdlp, { log })
const resolver = createResolver({ ytdlp, maxHeight: config.maxHeight, audioCache: cache })
const diagnostics = createDiagnostics()
const handler = createHandler({ config, ytdlp, resolver, cache, diagnostics, log, version })

const ytdlpVersion = await ytdlp.version()
if (!ytdlpVersion) log(`TomTube: yt-dlp was not found at ${config.ytdlp.binary}; extraction will fail until it is installed (docs/TOMTUBE.md).`)

const server = createServer(handler)
// Streams can be long; the phone keeps its connection open while it buffers.
server.requestTimeout = 0
server.headersTimeout = 30_000
server.keepAliveTimeout = 65_000
server.on('error', (error) => { log(`TomTube could not listen on ${config.host}:${config.port}: ${error.code || error.message}`); process.exit(1) })
server.listen(config.port, config.host, () => log(`TomTube listening on http://${config.host}:${config.port} (yt-dlp ${ytdlpVersion || 'missing'})`))

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
