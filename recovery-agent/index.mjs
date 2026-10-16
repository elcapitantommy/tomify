import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { audioFormatSummary, sanitizeToolError, selectBestAudioFormat } from './youtube.mjs'
import { findReusableTorrent } from './torrent.mjs'
import { archiveCandidate, archiveDownloadUrl, archiveMetadataUrl, archiveSearchUrl, selectArchiveAudioFiles, validateArchiveDownloadUrl } from './internet-archive.mjs'
import { deleteRecoveryArtifacts } from './deletion.mjs'
import { recoveryDerivativeExtension, recoveryDerivativeOperation } from './derivative.mjs'
import { ffmpegMetadataArguments, ffprobeTagJsonFormat } from './metadata.mjs'
import { decodeToolOutput } from './text-encoding.mjs'
import { buildArtworkProvenance, buildDerivativeArguments, coverDimensions, detectImageMime, validateArtworkUrl } from './artwork.mjs'
import { assertNzbIndexCandidateComplete, cancelAgentJob, cancelDownloader, downloaderConfig, downloaderStatus, findCompletedAudio, newznabDownloadUrl, nzbIndexConfig, nzbIndexDownloadUrl, parseIndexerConfig, searchUsenetProviders, submitDownloader, usenetCapability, usenetSearchQuery, validateCompletedPath } from './usenet.mjs'
import { importRemainingUsenetFiles, importUsenetCompletion, planDestination } from './usenet-import.mjs'
import { validateRecoveryAuthConfig } from './config.mjs'
import { createUsenetJobPoller } from './usenet-job.mjs'
import { createJobRunner, jobPollIntervalMs } from './jobs.mjs'
import { rebootConfig, scheduleReboot } from './system.mjs'
import { createVpnController, nordvpnEnvironment, nordvpnFailureMessage, vpnConfig } from './vpn.mjs'
import { createQbittorrentClient, extractArchives, findArchives, qbittorrentJobState, torrentCandidate, torrentCapability, torrentConfig, torrentSearchCandidates } from './torrent.mjs'
import { agentStatusResponse, healthResponse, recoveryAgentPackageVersion } from './health.mjs'
import { commitCoverFile, commitTrackFiles } from './commit.mjs'

let authConfiguration
try { authConfiguration = validateRecoveryAuthConfig() }
catch (error) {
  process.stderr.write(`Tomify recovery agent refused to start: ${error instanceof Error ? error.message : 'invalid authentication configuration'}\n`)
  process.exit(1)
}

const host = authConfiguration.host
const port = Number(process.env.TOMIFY_RECOVERY_PORT || 8788)
const recoveryRoot = resolve(process.env.TOMIFY_RECOVERY_DIR || './recovered-music')
const masterRoot = process.env.TOMIFY_MASTER_DIR ? resolve(process.env.TOMIFY_MASTER_DIR) : null
const youtubeCookies = process.env.TOMIFY_YOUTUBE_COOKIES ? resolve(process.env.TOMIFY_YOUTUBE_COOKIES) : null
const token = authConfiguration.token
const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp'
const reboot = rebootConfig()
const vpnSettings = vpnConfig()
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const configuredArchiveMaxBytes = Number(process.env.TOMIFY_ARCHIVE_MAX_BYTES || 1024 * 1024 * 1024)
const archiveMaxBytes = Number.isFinite(configuredArchiveMaxBytes) && configuredArchiveMaxBytes > 0 ? configuredArchiveMaxBytes : 1024 * 1024 * 1024
const usenetDownloadRoot = process.env.TOMIFY_USENET_DOWNLOAD_DIR ? resolve(process.env.TOMIFY_USENET_DOWNLOAD_DIR) : null
const usenetStateRoot = resolve(process.env.TOMIFY_RECOVERY_STATE_DIR || join(recoveryRoot, '.tomify-state'))
const configuredUsenetMaxBytes = Number(process.env.TOMIFY_USENET_MAX_BYTES || 2 * 1024 * 1024 * 1024)
const usenetMaxBytes = Number.isFinite(configuredUsenetMaxBytes) && configuredUsenetMaxBytes > 0 ? configuredUsenetMaxBytes : 2 * 1024 * 1024 * 1024
const newznabIndexers = parseIndexerConfig(process.env.TOMIFY_NEWZNAB_INDEXERS_JSON || '')
const nzbIndex = nzbIndexConfig()
const usenetDownloader = downloaderConfig()
const usenet = usenetCapability({ newznabIndexers, nzbIndex, downloader: usenetDownloader, downloadRoot: usenetDownloadRoot })
const torrentDownloadRoot = process.env.TOMIFY_TORRENT_DOWNLOAD_DIR ? resolve(process.env.TOMIFY_TORRENT_DOWNLOAD_DIR) : null
const torrentDownloader = torrentConfig()
const torrent = torrentCapability({ config: torrentDownloader, downloadRoot: torrentDownloadRoot })
const qbittorrent = torrentDownloader ? createQbittorrentClient(torrentDownloader) : null
const sevenZip = process.env.SEVEN_ZIP_PATH || '7z'
const health = healthResponse(process.env, await recoveryAgentPackageVersion())

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

if (masterRoot && (inside(recoveryRoot, masterRoot) || inside(masterRoot, recoveryRoot))) throw new Error('TOMIFY_RECOVERY_DIR must be separate from TOMIFY_MASTER_DIR.')
if (youtubeCookies && inside(youtubeCookies, recoveryRoot)) throw new Error('TOMIFY_YOUTUBE_COOKIES must be outside the recovery library.')
if (usenetDownloadRoot && masterRoot && (inside(usenetDownloadRoot, masterRoot) || inside(masterRoot, usenetDownloadRoot))) throw new Error('TOMIFY_USENET_DOWNLOAD_DIR must be separate from TOMIFY_MASTER_DIR.')
if (torrentDownloadRoot && masterRoot && (inside(torrentDownloadRoot, masterRoot) || inside(masterRoot, torrentDownloadRoot))) throw new Error('TOMIFY_TORRENT_DOWNLOAD_DIR must be separate from TOMIFY_MASTER_DIR.')
if (torrentDownloadRoot && (inside(torrentDownloadRoot, recoveryRoot) || inside(recoveryRoot, torrentDownloadRoot))) throw new Error('TOMIFY_TORRENT_DOWNLOAD_DIR must be separate from TOMIFY_RECOVERY_DIR.')

function safeName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 120)
  return cleaned || fallback
}

function youtubeUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Only HTTPS YouTube sources are supported.')
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!['youtube.com', 'music.youtube.com', 'youtu.be'].includes(hostname)) throw new Error('The selected source is not a YouTube URL.')
  return url.toString()
}

// describeStdout lets a caller report a tool that prints its errors to stdout (nordvpn) instead of a bare exit code.
function run(command, args, timeoutMs = 120_000, env = process.env, describeStdout = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    // Keep raw bytes until the end: decoding per chunk splits multi-byte characters, and tag
    // values may not be valid UTF-8 at all (see decodeToolOutput).
    const stdoutChunks = []
    let stdoutBytes = 0
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${basename(command)} timed out.`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); stdoutBytes += chunk.length; if (stdoutBytes > 8_000_000) child.kill('SIGKILL') })
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 2_000_000) child.kill('SIGKILL') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout: decodeToolOutput(Buffer.concat(stdoutChunks)).trim(), stderr: stderr.trim() })
      else reject(new Error(`${basename(command)} failed: ${sanitizeToolError(stderr || describeStdout?.(decodeToolOutput(Buffer.concat(stdoutChunks))) || `exit ${code}`, [youtubeCookies])}`))
    })
  })
}

async function cookieStatus() {
  if (!youtubeCookies) return { configured: false, usable: false, state: 'not-configured' }
  try {
    const details = await stat(youtubeCookies)
    await access(youtubeCookies, fsConstants.R_OK)
    if (!details.isFile()) return { configured: true, usable: false, state: 'not-a-file' }
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) return { configured: true, usable: false, state: 'insecure-permissions' }
    return { configured: true, usable: true, state: 'configured' }
  } catch (error) {
    return { configured: true, usable: false, state: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

function cookieArguments(useAuthenticatedSession) {
  return useAuthenticatedSession && youtubeCookies ? ['--cookies', youtubeCookies] : []
}

async function withAnonymousFallback(operation) {
  const status = await cookieStatus()
  if (status.usable) {
    try { return { value: await operation(true), authenticatedAccessUsed: true, authenticationFallback: false } }
    catch { /* An expired or rejected session must not make anonymous extraction unavailable. */ }
  }
  return { value: await operation(false), authenticatedAccessUsed: false, authenticationFallback: status.usable }
}

async function parseBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function authorised(request) {
  if (authConfiguration.insecureLoopback) return true
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const expectedBuffer = Buffer.from(token)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function searchYouTube(track) {
  const artist = String(track?.artist || '').trim().slice(0, 240)
  const title = String(track?.title || '').trim().slice(0, 240)
  const album = String(track?.album || '').trim().slice(0, 240)
  if (!artist && !title && !album) throw new Error('An artist, album or title is required.')
  const query = title ? `${[artist, title].filter(Boolean).join(' ')} official audio` : `${[artist, album].filter(Boolean).join(' ')} full album`
  const search = await withAnonymousFallback(async (authenticated) => {
    const { stdout } = await run(ytdlp, ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', ...cookieArguments(authenticated), `ytsearch8:${query}`])
    return JSON.parse(stdout)
  })
  const entries = Array.isArray(search.value.entries) ? search.value.entries : []
  return entries.filter(Boolean).map((entry) => {
    const formats = Array.isArray(entry.formats) ? entry.formats.filter((format) => format?.acodec && format.acodec !== 'none') : []
    const best = selectBestAudioFormat(formats)
    return {
      externalId: String(entry.id || ''), url: `https://www.youtube.com/watch?v=${encodeURIComponent(String(entry.id || ''))}`,
      title: String(entry.title || ''), channel: String(entry.channel || entry.uploader || 'Unknown channel'),
      channelId: entry.channel_id || entry.uploader_id || null, duration: Number.isFinite(entry.duration) ? entry.duration : null,
      thumbnail: entry.thumbnail || null,
      provenance: { extractor: entry.extractor_key || entry.extractor || 'YouTube', availability: entry.availability || 'public', discoveryMode: search.authenticatedAccessUsed ? 'authenticated-youtube-session' : 'anonymous-youtube', availableAudioFormatCount: formats.length, preferredFormat: best ? audioFormatSummary(best) : null },
    }
  }).filter((entry) => entry.externalId)
}

async function fetchJson(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'user-agent': 'Tomify/0.1 recovery-agent' } })
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
  return response.json()
}

async function searchInternetArchive(track) {
  const search = await fetchJson(archiveSearchUrl(track), 'Internet Archive search')
  const documents = Array.isArray(search?.response?.docs) ? search.response.docs.slice(0, 8) : []
  const results = []
  for (const document of documents) {
    const identifier = String(document?.identifier || '')
    if (!identifier) continue
    const item = await fetchJson(archiveMetadataUrl(identifier), 'Internet Archive metadata')
    if (item?.is_dark || item?.d1 || !item?.metadata) continue
    for (const file of selectArchiveAudioFiles(item, 3)) results.push(archiveCandidate(identifier, item.metadata, file))
    if (results.length >= 12) break
  }
  return results.slice(0, 12)
}

async function searchUsenet(track, mode) {
  if (!usenet.available) throw new Error('Usenet Recovery is not fully configured.')
  return searchUsenetProviders(newznabIndexers, nzbIndex, track, mode)
}

async function fetchArchiveFile(url, destination, expectedHashes = {}) {
  let currentUrl = validateArchiveDownloadUrl(url)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000), headers: { 'user-agent': 'Tomify/0.1 recovery-agent' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === 5) throw new Error('Internet Archive returned an invalid redirect.')
      await response.body?.cancel()
      currentUrl = validateArchiveDownloadUrl(new URL(location, currentUrl).toString())
      continue
    }
    if (!response.ok || !response.body) throw new Error(`Internet Archive download returned HTTP ${response.status}.`)
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > archiveMaxBytes) throw new Error('Internet Archive audio file exceeds the configured size limit.')
    let received = 0
    const md5 = createHash('md5')
    const sha1 = createHash('sha1')
    const limiter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; md5.update(chunk); sha1.update(chunk); callback(received > archiveMaxBytes ? new Error('Internet Archive audio file exceeds the configured size limit.') : null, chunk) } })
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: 'wx' }))
    const hashes = { md5: md5.digest('hex'), sha1: sha1.digest('hex') }
    if (expectedHashes.md5 && hashes.md5 !== String(expectedHashes.md5).toLowerCase()) throw new Error('Internet Archive audio failed its MD5 integrity check.')
    if (expectedHashes.sha1 && hashes.sha1 !== String(expectedHashes.sha1).toLowerCase()) throw new Error('Internet Archive audio failed its SHA-1 integrity check.')
    return { finalUrl: currentUrl, bytes: received, hashes }
  }
  throw new Error('Internet Archive download failed.')
}

async function probe(path) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags', '-of', ffprobeTagJsonFormat, path])
  const value = JSON.parse(stdout)
  const audio = (value.streams || []).find((stream) => stream.codec_type === 'audio') || {}
  return { codec: audio.codec_name || null, container: value.format?.format_name || extname(path).slice(1) || null, bitrate: Number(audio.bit_rate || value.format?.bit_rate) || null, sampleRate: Number(audio.sample_rate) || null, channels: Number(audio.channels) || null, duration: Number(value.format?.duration) || null, tags: { ...(audio.tags || {}), ...(value.format?.tags || {}) } }
}

async function probeImage(path) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path])
  const stream = JSON.parse(stdout).streams?.[0] || {}
  return { codec: stream.codec_name || null, width: Number(stream.width) || 0, height: Number(stream.height) || 0 }
}

async function fetchArtwork(url) {
  let currentUrl = validateArtworkUrl(url)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { accept: 'image/jpeg,image/png,image/webp' } })
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: currentUrl }
    const location = response.headers.get('location')
    if (!location) throw new Error('Artwork provider returned an invalid redirect.')
    if (redirects === 5) throw new Error('Artwork provider returned too many redirects.')
    await response.body?.cancel()
    currentUrl = validateArtworkUrl(new URL(location, currentUrl).toString())
  }
  throw new Error('Artwork download failed.')
}

async function prepareArtwork(candidate, temporaryRoot) {
  if (!candidate) return null
  const sourceUrl = validateArtworkUrl(candidate.url)
  const { response, finalUrl } = await fetchArtwork(sourceUrl)
  if (!response.ok) throw new Error(`Artwork provider returned HTTP ${response.status}.`)
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > 25 * 1024 * 1024) throw new Error('Artwork file is too large.')
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Artwork file is too large.')
  const mimeType = detectImageMime(buffer, response.headers.get('content-type'))
  const rawExtension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg'
  const rawPath = join(temporaryRoot, `artwork-source${rawExtension}`)
  await writeFile(rawPath, Buffer.from(buffer), { flag: 'wx' })
  const fetched = await probeImage(rawPath)
  const target = coverDimensions(fetched.width, fetched.height)
  const coverPath = join(temporaryRoot, 'cover.jpg')
  await run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', rawPath, '-frames:v', '1', '-vf', target.filter, '-q:v', '2', coverPath], 2 * 60_000)
  const final = await probeImage(coverPath)
  return { coverPath, provider: candidate.provider, providerLabel: candidate.providerLabel || candidate.provider, providerId: candidate.providerId || null, originalUrl: sourceUrl, fetchedUrl: finalUrl, fetchedDimensions: { width: fetched.width, height: fetched.height }, finalDimensions: { width: final.width, height: final.height }, sourceMimeType: mimeType, finalMimeType: 'image/jpeg', acquiredAt: new Date().toISOString() }
}

async function inspectAndDownload(sourceUrl, temporaryRoot) {
  return withAnonymousFallback(async (authenticated) => {
    const authArgs = cookieArguments(authenticated)
    const { stdout: metadataJson } = await run(ytdlp, ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', ...authArgs, sourceUrl])
    const metadata = JSON.parse(metadataJson)
    const formats = Array.isArray(metadata.formats) ? metadata.formats.filter((format) => format?.acodec && format.acodec !== 'none') : []
    const selected = selectBestAudioFormat(formats)
    if (!selected) throw new Error('YouTube did not expose an audio stream for this candidate.')
    const outputTemplate = join(temporaryRoot, authenticated ? 'authenticated.%(ext)s' : 'anonymous.%(ext)s')
    const { stdout } = await run(ytdlp, ['--ignore-config', '--no-playlist', '--no-overwrites', '--no-warnings', ...authArgs, '-f', String(selected.format_id), '--print', 'after_move:filepath', '-o', outputTemplate, sourceUrl], 10 * 60_000)
    const sourcePath = resolve(stdout.split(/\r?\n/).filter(Boolean).at(-1) || '')
    if (!inside(sourcePath, temporaryRoot)) throw new Error('Downloader returned an unexpected file path.')
    await access(sourcePath, fsConstants.R_OK)
    return { sourcePath, metadata, formats, selected }
  })
}

async function acquireYouTube(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  const sourceUrl = youtubeUrl(body?.candidate?.url)
  const track = body?.track || {}
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tomify-recovery-'))
  try {
    const acquisition = await inspectAndDownload(sourceUrl, temporaryRoot)
    const { sourcePath, metadata, formats, selected } = acquisition.value
    const sourceExtension = extname(sourcePath).toLowerCase() || '.mka'
    const sourceQuality = await probe(sourcePath)
    const derivativeExtension = recoveryDerivativeExtension(sourcePath, sourceQuality)
    const { finalDirectory, sourceDirectory, finalPath, originalPath } = await planDestination(recoveryRoot, track, sourceExtension, derivativeExtension)
    await mkdir(sourceDirectory, { recursive: true })
    for (const path of [finalPath, originalPath, `${finalPath}.tomify.json`]) {
      try { await access(path); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }

    const artwork = await prepareArtwork(body.artwork, temporaryRoot)
    const taggedPath = join(finalDirectory, `.${crypto.randomUUID()}${derivativeExtension}`)
    const releaseCoverPath = resolve(finalDirectory, 'cover.jpg')
    if (!inside(releaseCoverPath, recoveryRoot)) throw new Error('Unsafe recovery artwork destination.')
    const comment = `Tomify lossy recovery copy; source=${sourceUrl}; authorisation=${body.authorisation.basis}`
    const tags = ffmpegMetadataArguments({ ...track, sourceUrl }, comment, sourceQuality)
    const derivativePlan = buildDerivativeArguments({ sourcePath, outputPath: taggedPath, coverPath: artwork?.coverPath || null, tags })
    let trackCommitted = false
    let coverCreated = false
    try {
      await run(ffmpeg, derivativePlan.args, 5 * 60_000)
      const derivativeQuality = await probe(taggedPath)
      await commitTrackFiles({ originalSource: sourcePath, derivativeSource: taggedPath, originalPath, derivativePath: finalPath })
      trackCommitted = true
      const coverCommit = artwork ? await commitCoverFile(artwork.coverPath, releaseCoverPath) : null
      coverCreated = Boolean(coverCommit?.created)
      const importedAt = new Date().toISOString()
      const baseArtworkProvenance = buildArtworkProvenance(artwork, derivativePlan, releaseCoverPath)
      const artworkProvenance = baseArtworkProvenance ? { ...baseArtworkProvenance, coverFileCreated: coverCreated, existingCoverKept: Boolean(coverCommit?.existingCoverKept) } : null
      const provenance = {
        source: 'youtube', sourceUrl, videoId: String(metadata.id || body.candidate.externalId || ''), sourceTitle: String(metadata.title || body.candidate.title || ''),
        sourceChannel: String(metadata.channel || metadata.uploader || body.candidate.channel || ''), acquisitionMode: acquisition.authenticatedAccessUsed ? 'authenticated-youtube-session' : 'anonymous-youtube',
        authenticatedAccessUsed: acquisition.authenticatedAccessUsed, authenticationFallback: acquisition.authenticationFallback, selectedFormatId: String(selected.format_id),
        availableAudioFormats: formats.map(audioFormatSummary), acquiredAt: importedAt, rightsBasis: body.authorisation.basis,
        confirmedBy: body.authorisation.confirmedBy || null, confirmedAt: body.authorisation.confirmedAt || null, archiveStatus: 'lossy-recovery-copy',
        wantedMetadata: body.wantedMetadata || null, resolvedMetadata: track, catalogueSource: body.catalogueSource || null, metadataResolution: body.metadataResolution || null,
        artwork: artworkProvenance,
        sourceAudio: { path: originalPath, extension: sourceExtension, quality: sourceQuality, preservedOriginal: true },
        derivative: { path: finalPath, extension: derivativeExtension, containerRemuxed: sourceExtension !== derivativeExtension, createdByTomify: true, operation: recoveryDerivativeOperation(sourceExtension, derivativeExtension, derivativePlan.embedded), audioStreamCopied: true, transcoded: false, quality: derivativeQuality },
      }
      await writeFile(`${finalPath}.tomify.json`, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' })
      return { path: finalPath, originalPath, quality: sourceQuality, derivative: provenance.derivative, artwork: artworkProvenance, provenance }
    } catch (error) {
      await unlink(`${finalPath}.tomify.json`).catch(() => {})
      if (coverCreated) await unlink(releaseCoverPath).catch(() => {})
      if (trackCommitted) {
        await unlink(finalPath).catch(() => {})
        await unlink(originalPath).catch(() => {})
      }
      throw error
    } finally {
      await unlink(taggedPath).catch(() => {})
    }
  } finally {
    const resolvedTemporaryRoot = resolve(temporaryRoot)
    if (inside(resolvedTemporaryRoot, resolve(tmpdir())) && basename(resolvedTemporaryRoot).startsWith('tomify-recovery-')) await rm(resolvedTemporaryRoot, { recursive: true, force: true })
  }
}

async function acquireInternetArchive(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  const reference = body?.candidate?.provenance
  const identifier = String(reference?.identifier || '')
  const filename = String(reference?.filename || '')
  const metadata = await fetchJson(archiveMetadataUrl(identifier), 'Internet Archive metadata')
  const file = (Array.isArray(metadata?.files) ? metadata.files : []).find((entry) => entry?.name === filename)
  if (!file || !selectArchiveAudioFiles({ files: [file] }, 1).length) throw new Error('The selected Internet Archive audio file is no longer available.')
  const expectedUrl = archiveDownloadUrl(identifier, filename)
  const track = body?.track || {}
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tomify-recovery-'))
  try {
    const sourceExtension = extname(filename).toLowerCase() || '.mka'
    const sourcePath = resolve(temporaryRoot, `archive-source${sourceExtension}`)
    const download = await fetchArchiveFile(expectedUrl, sourcePath, { md5: file.md5, sha1: file.sha1 })
    const sourceQuality = await probe(sourcePath)
    if (!sourceQuality.codec || !sourceQuality.duration) throw new Error('The Internet Archive file is not valid audio.')
    const derivativeExtension = recoveryDerivativeExtension(sourcePath, sourceQuality)
    const { finalDirectory, sourceDirectory, finalPath, originalPath } = await planDestination(recoveryRoot, track, sourceExtension, derivativeExtension)
    await mkdir(sourceDirectory, { recursive: true })
    for (const path of [finalPath, originalPath, `${finalPath}.tomify.json`]) {
      try { await access(path); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    const artwork = await prepareArtwork(body.artwork, temporaryRoot)
    const taggedPath = join(finalDirectory, `.${crypto.randomUUID()}${derivativeExtension}`)
    const releaseCoverPath = resolve(finalDirectory, 'cover.jpg')
    if (!inside(releaseCoverPath, recoveryRoot)) throw new Error('Unsafe recovery artwork destination.')
    const sourceUrl = `https://archive.org/details/${encodeURIComponent(identifier)}`
    const comment = `Tomify Internet Archive recovery copy; source=${sourceUrl}; authorisation=${body.authorisation.basis}`
    const tags = ffmpegMetadataArguments({ ...track, sourceUrl }, comment, sourceQuality)
    const derivativePlan = buildDerivativeArguments({ sourcePath, outputPath: taggedPath, coverPath: artwork?.coverPath || null, tags })
    let trackCommitted = false
    let coverCreated = false
    try {
      await run(ffmpeg, derivativePlan.args, 5 * 60_000)
      const derivativeQuality = await probe(taggedPath)
      await commitTrackFiles({ originalSource: sourcePath, derivativeSource: taggedPath, originalPath, derivativePath: finalPath })
      trackCommitted = true
      const coverCommit = artwork ? await commitCoverFile(artwork.coverPath, releaseCoverPath) : null
      coverCreated = Boolean(coverCommit?.created)
      const acquiredAt = new Date().toISOString()
      const baseArtworkProvenance = buildArtworkProvenance(artwork, derivativePlan, releaseCoverPath)
      const artworkProvenance = baseArtworkProvenance ? { ...baseArtworkProvenance, coverFileCreated: coverCreated, existingCoverKept: Boolean(coverCommit?.existingCoverKept) } : null
      const provenance = {
        source: 'internet-archive', sourceUrl, archiveIdentifier: identifier, archiveFilename: filename,
        archiveDownloadUrl: download.finalUrl, archiveItemTitle: metadata.metadata?.title || null, archiveCreator: metadata.metadata?.creator || null,
        licenseUrl: metadata.metadata?.licenseurl || null, rights: metadata.metadata?.rights || null, collection: metadata.metadata?.collection || null,
        fileFormat: file.format || null, fileSource: file.source || null, sourceSize: download.bytes, md5: file.md5 || null, sha1: file.sha1 || null,
        acquiredAt, rightsBasis: body.authorisation.basis, confirmedBy: body.authorisation.confirmedBy || null, confirmedAt: body.authorisation.confirmedAt || null,
        archiveStatus: 'internet-archive-recovery-copy', wantedMetadata: body.wantedMetadata || null, resolvedMetadata: track,
        catalogueSource: body.catalogueSource || null, metadataResolution: body.metadataResolution || null, artwork: artworkProvenance,
        sourceAudio: { path: originalPath, extension: sourceExtension, quality: sourceQuality, preservedOriginal: true },
        derivative: { path: finalPath, extension: derivativeExtension, containerRemuxed: sourceExtension !== derivativeExtension, createdByTomify: true, operation: recoveryDerivativeOperation(sourceExtension, derivativeExtension, derivativePlan.embedded), audioStreamCopied: true, transcoded: false, quality: derivativeQuality },
      }
      await writeFile(`${finalPath}.tomify.json`, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' })
      return { path: finalPath, originalPath, quality: sourceQuality, derivative: provenance.derivative, artwork: artworkProvenance, provenance }
    } catch (error) {
      await unlink(`${finalPath}.tomify.json`).catch(() => {})
      if (coverCreated) await unlink(releaseCoverPath).catch(() => {})
      if (trackCommitted) {
        await unlink(finalPath).catch(() => {})
        await unlink(originalPath).catch(() => {})
      }
      throw error
    } finally {
      await unlink(taggedPath).catch(() => {})
    }
  } finally {
    const resolvedTemporaryRoot = resolve(temporaryRoot)
    if (inside(resolvedTemporaryRoot, resolve(tmpdir())) && basename(resolvedTemporaryRoot).startsWith('tomify-recovery-')) await rm(resolvedTemporaryRoot, { recursive: true, force: true })
  }
}

function usenetJobPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id || ''))) throw new Error('Invalid Usenet job id.')
  const path = resolve(usenetStateRoot, `${id}.json`)
  if (!inside(path, usenetStateRoot)) throw new Error('Unsafe Usenet job path.')
  return path
}

async function saveUsenetJob(job) {
  await mkdir(usenetStateRoot, { recursive: true })
  const path = usenetJobPath(job.id)
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function loadUsenetJob(id) {
  return JSON.parse(await readFile(usenetJobPath(id), 'utf8'))
}

async function queueUsenet(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  if (!usenet.available) throw new Error('Usenet Recovery is not fully configured.')
  const reference = body?.candidate?.provenance
  let provider
  let nzbUrl
  if (reference?.providerType === 'nzbindex') {
    if (!nzbIndex || reference.providerId !== nzbIndex.id || !reference.collectionId) throw new Error('The selected NZBIndex result is no longer valid.')
    assertNzbIndexCandidateComplete(reference)
    provider = nzbIndex
    nzbUrl = nzbIndexDownloadUrl(nzbIndex, reference.collectionId)
  } else {
    const indexer = newznabIndexers.find((value) => value.id === reference?.providerId)
    if (!indexer || !reference?.guid) throw new Error('The selected Newznab result is no longer valid.')
    provider = { ...indexer, type: 'newznab' }
    nzbUrl = newznabDownloadUrl(indexer, reference.guid)
  }
  if (Number(reference.size) > usenetMaxBytes) throw new Error('The selected Usenet result exceeds TOMIFY_USENET_MAX_BYTES.')
  const id = crypto.randomUUID()
  const displayName = `Tomify - ${safeName(body?.track?.artist, 'Unknown Artist')} - ${safeName(body?.track?.title, 'Recovery')}`
  const submitted = await submitDownloader(usenetDownloader, nzbUrl, displayName)
  const job = {
    id, version: 1, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    downloader: submitted.downloader, remoteId: submitted.remoteId,
    indexer: { type: provider.type, id: provider.id, name: provider.name },
    result: { externalId: body.candidate.externalId || null, resultId: reference.resultId || reference.collectionId || reference.guid || null, title: body.candidate.title || null, detailsUrl: body.candidate.url || null, postedAt: reference.postedAt || null, searchMode: reference.searchMode || 'track', searchFields: Array.isArray(reference.searchFields) ? reference.searchFields : null, size: reference.size || null, ageDays: reference.ageDays || null },
    request: { track: body.track || {}, wantedMetadata: body.wantedMetadata || null, catalogueSource: body.catalogueSource || null, metadataResolution: body.metadataResolution || null, artwork: body.artwork || null, authorisation: body.authorisation },
  }
  await saveUsenetJob(job)
  jobRunner.track(id)
  return { job: { id, status: 'queued', progress: 0, provider: provider.name, downloader: submitted.downloader } }
}

// Every saved job, for finding an earlier failed torrent job for the same link.
async function savedUsenetJobs() {
  const names = await readdir(usenetStateRoot).catch(() => [])
  const jobs = []
  for (const name of names.filter((value) => /^[a-f0-9-]{36}\.json$/.test(value))) {
    const job = await loadUsenetJob(name.slice(0, -5)).catch(() => null)
    if (job && job.status !== 'cancelled') jobs.push(job)
  }
  return jobs
}

async function queueTorrent(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  if (!torrent.available) throw new Error('Torrent downloads are not configured on the recovery agent.')
  const reference = body?.candidate?.provenance
  if (reference?.providerType !== 'torrent' || !reference.link) throw new Error('The selected torrent link is no longer valid.')
  // Parse the link again rather than trusting the stored candidate.
  const candidate = torrentCandidate(reference.link, body.track)
  const id = crypto.randomUUID()
  const tag = `tomify-${id}`
  const reusable = await findReusableTorrent(candidate.provenance, { client: qbittorrent, loadJob: (jobId) => loadUsenetJob(jobId).catch(() => null), savedJobs: savedUsenetJobs })
  const submitted = reusable
    ? await qbittorrent.retag(reusable.hash, { tag, previousTags: reusable.tags })
    : await qbittorrent.add(candidate.provenance.link, { tag, savePath: torrentDownloader.downloadRoot || torrentDownloadRoot })
  const searchMode = ['track', 'release'].includes(reference.searchMode) ? reference.searchMode : candidate.provenance.searchMode
  const job = {
    id, version: 1, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    downloader: submitted.downloader, remoteId: submitted.remoteId,
    indexer: reference.providerId === 'qbittorrent-search' ? { type: 'torrent', id: 'qbittorrent-search', name: String(reference.providerName || 'Torrent search').slice(0, 120) } : { type: 'torrent', id: 'torrent-link', name: 'Torrent link' },
    torrent: { infoHash: candidate.provenance.infoHash, linkType: candidate.provenance.linkType },
    result: { externalId: body.candidate.externalId || null, resultId: candidate.provenance.resultId, title: body.candidate.title || null, detailsUrl: candidate.provenance.displayUrl, postedAt: null, searchMode, searchFields: Array.isArray(reference.searchFields) ? reference.searchFields : null, size: Number.isFinite(reference.size) ? reference.size : null, ageDays: null },
    request: { track: body.track || {}, wantedMetadata: body.wantedMetadata || null, catalogueSource: body.catalogueSource || null, metadataResolution: body.metadataResolution || null, artwork: body.artwork || null, authorisation: body.authorisation },
  }
  await saveUsenetJob(job)
  jobRunner.track(id)
  return { job: { id, status: 'queued', progress: 0, provider: job.indexer.name, downloader: submitted.downloader } }
}

const directAcquisitions = { youtube: { name: 'YouTube', acquire: (request) => acquireYouTube(request) }, 'internet-archive': { name: 'Internet Archive', acquire: (request) => acquireInternetArchive(request) } }

// A YouTube or Internet Archive acquisition queued as a job for the runner, for a Worker that asks for one with
// `background: true`. Older Workers do not, and still get the synchronous result.
async function queueDirectAcquisition(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  const backend = directAcquisitions[body.backend]
  if (body.backend === 'youtube') youtubeUrl(body?.candidate?.url)
  if (body.backend === 'internet-archive' && (!body?.candidate?.provenance?.identifier || !body.candidate.provenance.filename)) throw new Error('The selected Internet Archive file is no longer valid.')
  const id = crypto.randomUUID()
  const { background: _background, ...request } = body
  const job = {
    id, version: 1, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    downloader: body.backend, remoteId: null,
    indexer: { type: body.backend, id: body.backend, name: backend.name },
    result: { externalId: body.candidate?.externalId || null, resultId: null, title: body.candidate?.title || null, detailsUrl: body.candidate?.url || null },
    request,
  }
  await saveUsenetJob(job)
  jobRunner.track(id)
  return { job: { id, status: 'queued', progress: 0, provider: backend.name, downloader: body.backend } }
}

async function torrentStatus(job) {
  const info = await qbittorrent.info(job.remoteId)
  if (info?.hash && !job.torrent?.infoHash) job.torrent = { ...(job.torrent || {}), infoHash: String(info.hash).toLowerCase() }
  const state = qbittorrentJobState(info, { createdAt: job.createdAt, maxBytes: torrentDownloader.maxBytes })
  if (state.remove && info?.hash) await qbittorrent.remove(info.hash, true).catch(() => {})
  return state
}

function torrentExtractionPath(job) {
  const path = resolve(usenetStateRoot, 'torrent-extracted', job.id)
  if (!inside(path, usenetStateRoot) || !/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Unsafe torrent extraction path.')
  return path
}

// Finds the audio in a completed torrent, unpacking any zip, rar or 7z archives into Tomify's own state
// directory so qBittorrent's seeding copy is never modified. The caller removes the extracted copy afterwards.
async function torrentAudio(job, completedPath) {
  const extractionPath = torrentExtractionPath(job)
  await rm(extractionPath, { recursive: true, force: true })
  const archives = await findArchives(completedPath)
  const files = [...(await findCompletedAudio(completedPath, { maxBytes: torrentDownloader.maxBytes, allowEmpty: true, label: 'torrent' })).files]
  if (archives.length) {
    await mkdir(extractionPath, { recursive: true })
    for (const directory of await extractArchives(archives, extractionPath, { run, sevenZip, maxBytes: torrentDownloader.maxBytes })) {
      files.push(...(await findCompletedAudio(directory, { maxBytes: torrentDownloader.maxBytes, allowEmpty: true, label: 'torrent archive' })).files)
    }
    job.extractedPath = extractionPath
  }
  if (!files.length) throw new Error(archives.length ? 'The torrent and its archives contain no supported audio files.' : 'The completed torrent contains no supported audio files.')
  return { files, extractionPath }
}

// A path from qBittorrent is in its own view of the filesystem; a saved completedPath is already the host path.
// Removes the job's torrent and its downloaded data from qBittorrent. Returns false when it was already gone.
async function removeTorrent(job) {
  const info = await qbittorrent.info(job.remoteId)
  const hash = info?.hash || job.torrent?.infoHash
  if (!info && !hash) return false
  await qbittorrent.remove(String(hash).toLowerCase(), true)
  return Boolean(info)
}

// Imports the completed torrent, then removes it and its data from qBittorrent: the preserved originals
// under .tomify-source are the copy Tomify keeps. A failed removal is recorded but does not undo the import.
async function completeTorrentJob(job, state, importFiles) {
  const completedPath = await validateCompletedPath(state.completedPath, torrentDownloadRoot, torrentDownloader.downloadRoot)
  job.completedPath = completedPath
  const { files, extractionPath } = await torrentAudio(job, completedPath)
  let result
  try { result = await importFiles(files) }
  finally { await rm(extractionPath, { recursive: true, force: true }) }
  try { await removeTorrent(job); job.torrentRemovedAt = new Date().toISOString() }
  catch (error) { job.torrentRemovalError = sanitizeToolError(error instanceof Error ? error.message : 'Could not remove the torrent from qBittorrent.', []) }
  return result
}

// Stops any queued recovery job. If its poll has already begun importing, cancellation waits for that import
// and reports its paths so the Worker can remove the raced recovery copy before returning to candidate review.
async function cancelRecoveryJob(body) {
  let job
  try { job = await loadUsenetJob(String(body?.jobId || '')) }
  catch (error) { if (error?.code === 'ENOENT') return { cancelled: true, remoteRemoved: false, importedPaths: [] }; throw error }
  if (job.status === 'cancelled') {
    const importedPaths = (Array.isArray(job.importResult?.importedTracks) ? job.importResult.importedTracks : []).map((track) => track?.path).filter((path) => typeof path === 'string')
    if (typeof job.importResult?.path === 'string' && job.importResult.path && !importedPaths.includes(job.importResult.path)) importedPaths.push(job.importResult.path)
    return { cancelled: true, remoteRemoved: false, importedPaths }
  }
  const { remoteRemoved, importedPaths } = await cancelAgentJob(job, {
    forget: (id) => jobRunner.forget(id),
    settled: (id) => pollUsenetJob.settled(id),
    reload: loadUsenetJob,
    saveJob: saveUsenetJob,
    removeRemote: async (current) => {
      if (current.downloader === 'qbittorrent') {
        if (!qbittorrent) throw new Error('Torrent downloads are not configured on the recovery agent.')
        const removed = await removeTorrent(current)
        await rm(torrentExtractionPath(current), { recursive: true, force: true })
        return removed
      }
      if (current.downloader === 'sabnzbd' || current.downloader === 'nzbget') {
        if (!usenetDownloader || usenetDownloader.type !== current.downloader) throw new Error('The job\'s Usenet downloader is not configured on the recovery agent.')
        return cancelDownloader(usenetDownloader, current.remoteId)
      }
      // Direct YouTube and Internet Archive jobs have no remote queue. Waiting above lets an in-flight
      // acquisition finish so its imported paths can be returned and cleaned up by the Worker.
      return false
    },
  })
  return { cancelled: true, remoteRemoved, ...(job.downloader === 'qbittorrent' ? { torrentRemoved: remoteRemoved } : {}), importedPaths }
}

const pollUsenetJob = createUsenetJobPoller({
  loadJob: loadUsenetJob,
  saveJob: saveUsenetJob,
  downloaderStatus: (remoteId, job) => {
    // A direct acquisition has no separate downloader: it downloads and imports in one step.
    if (directAcquisitions[job?.downloader]) return { status: 'completed', progress: 0, message: `Downloading from ${directAcquisitions[job.downloader].name}` }
    return job?.downloader === 'qbittorrent' ? torrentStatus(job) : downloaderStatus(usenetDownloader, remoteId, fetch, job)
  },
  completeJob: async (job, state) => {
    if (directAcquisitions[job.downloader]) return directAcquisitions[job.downloader].acquire(job.request)
    const options = { recoveryRoot, masterRoot, probe, prepareArtwork, run, ffmpeg }
    if (job.downloader === 'qbittorrent') return completeTorrentJob(job, state, (files) => importUsenetCompletion(job, files, options))
    const completedPath = await validateCompletedPath(state.completedPath, usenetDownloadRoot, usenetDownloader?.type === 'sabnzbd' ? usenetDownloader.downloadRoot : null)
    const discovered = await findCompletedAudio(completedPath, { maxBytes: usenetMaxBytes })
    job.completedPath = completedPath
    return importUsenetCompletion(job, discovered.files, options)
  },
  sanitizeError: (error) => sanitizeToolError(error instanceof Error ? error.message : 'Usenet recovery failed.', [youtubeCookies]),
})

// Advances every queued job in the background, so downloads and imports finish with no browser open.
const jobRunner = createJobRunner({
  listJobs: savedUsenetJobs,
  advance: pollUsenetJob,
  intervalMs: jobPollIntervalMs(),
  log: (message) => process.stderr.write(`${message}\n`),
})

const remainingImports = new Map()

async function importRemainingUsenet(body) {
  const key = String(body?.jobId || '')
  if (remainingImports.has(key)) throw new Error('The remaining files from this download are already being imported.')
  const operation = (async () => {
    const job = await loadUsenetJob(key)
    if (directAcquisitions[job.downloader]) throw new Error('Only a completed Usenet import can have the rest of its download imported.')
    if (job.downloader === 'qbittorrent') throw new Error('Torrents are removed from qBittorrent once imported, so there is nothing left to import. Add the album as wanted music (leave the track blank) and paste the link again.')
    let reportedPath = job.completedPath
    if (!reportedPath) {
      // Jobs completed before completedPath was saved: ask the downloader where it put the files.
      const state = await downloaderStatus(usenetDownloader, job.remoteId)
      if (state.status !== 'completed' || !state.completedPath) throw new Error('The downloader no longer reports where this download was saved.')
      reportedPath = state.completedPath
    }
    // A saved completedPath is already mapped to TOMIFY_USENET_DOWNLOAD_DIR; a fresh SABnzbd path still needs remapping.
    const downloaderRoot = !job.completedPath && usenetDownloader?.type === 'sabnzbd' ? usenetDownloader.downloadRoot : null
    const completedPath = await validateCompletedPath(reportedPath, usenetDownloadRoot, downloaderRoot)
    const discovered = await findCompletedAudio(completedPath, { maxBytes: usenetMaxBytes })
    const result = await importRemainingUsenetFiles(job, discovered.files, { recoveryRoot, masterRoot, probe, prepareArtwork, run, ffmpeg })
    job.completedPath = completedPath
    job.additionalImports = [...(job.additionalImports || []), { importedAt: new Date().toISOString(), importedCount: result.importedCount, sourceFiles: result.sourceFiles }]
    job.updatedAt = new Date().toISOString()
    await saveUsenetJob(job)
    return { result }
  })()
  remainingImports.set(key, operation)
  try { return await operation } finally { remainingImports.delete(key) }
}

async function diagnoseAuthenticatedYouTube() {
  const status = await cookieStatus()
  if (!status.usable) return { configured: false, extractionAvailable: false, state: status.state }
  try {
    await run(ytdlp, ['--ignore-config', '--no-playlist', '--skip-download', '--no-warnings', ...cookieArguments(true), '--print', '%(id)s', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'])
    return { configured: true, extractionAvailable: true, state: 'configured' }
  } catch { return { configured: true, extractionAvailable: false, state: 'authentication-failed' } }
}

async function deleteImportedRecovery(body) {
  const paths = Array.isArray(body?.importedPaths) ? body.importedPaths : []
  if (!paths.length || paths.some((path) => typeof path !== 'string')) throw new Error('At least one imported recovery path is required.')
  const uniquePaths = [...new Set(paths)]
  const results = []
  for (const importedPath of uniquePaths) results.push(await deleteRecoveryArtifacts(importedPath, recoveryRoot, masterRoot))
  return { deleted: results.flatMap((result) => result.deleted) }
}

// The unit's ProtectHome hides /home, and the nordvpn CLI exits unless it can create its config folder.
const nordvpnHome = join(usenetStateRoot, 'nordvpn-cli')
await mkdir(nordvpnHome, { recursive: true, mode: 0o700 })
const vpn = createVpnController({ config: vpnSettings, run: (command, args) => run(command, args, 60_000, nordvpnEnvironment(process.env, nordvpnHome), nordvpnFailureMessage) })

await mkdir(recoveryRoot, { recursive: true })
await mkdir(usenetStateRoot, { recursive: true })

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return send(response, 200, health)
    }
    if (!authorised(request)) return send(response, 401, { error: 'unauthorized' })
    if (request.method !== 'POST') return send(response, 404, { error: 'not-found' })
    const body = await parseBody(request)
    if (request.url === '/v1/status') {
      const auth = await cookieStatus()
      return send(response, 200, agentStatusResponse(health, { backends: [{ id: 'youtube', available: true, authentication: auth.usable ? 'configured' : 'not-configured' }, { id: 'internet-archive', available: true, authentication: 'not-required' }, { id: 'usenet', available: usenet.available, authentication: usenet.available ? 'configured' : 'not-configured', providerCount: usenet.providerCount, providers: [...(newznabIndexers.length ? ['newznab'] : []), ...(nzbIndex ? ['nzbindex'] : [])], downloader: usenetDownloader?.type || null }, { id: 'torrent', available: torrent.available, authentication: torrent.available ? 'configured' : 'not-configured', downloader: torrentDownloader?.type || null, search: torrent.available }], reboot: reboot.enabled ? 'enabled' : 'disabled', vpn: vpnSettings.enabled ? 'enabled' : 'disabled' }))
    }
    if (request.url === '/v1/diagnostics/youtube-auth') return send(response, 200, await diagnoseAuthenticatedYouTube())
    if (request.url === '/v1/search') {
      if (body.backend === 'youtube') return send(response, 200, { candidates: await searchYouTube(body.track) })
      if (body.backend === 'internet-archive') return send(response, 200, { candidates: await searchInternetArchive(body.track) })
      if (body.backend === 'usenet') return send(response, 200, { candidates: await searchUsenet(body.track, body.searchFields ?? body.searchMode ?? 'track') })
      if (body.backend === 'torrent') {
        if (!torrent.available) throw new Error('Torrent downloads are not configured on the recovery agent.')
        // A pasted link becomes one candidate; without one, qBittorrent's search plugins are searched for seeded results.
        if (body.link) return send(response, 200, { candidates: [torrentCandidate(body.link, body.track)] })
        const searchInput = body.searchFields ?? body.searchMode ?? 'track'
        return send(response, 200, { candidates: torrentSearchCandidates(await qbittorrent.search(usenetSearchQuery(body.track, searchInput)), body.track, searchInput) })
      }
      throw new Error('Unsupported recovery backend.')
    }
    if (request.url === '/v1/acquire') {
      if (directAcquisitions[body.backend] && body.background === true) return send(response, 202, await queueDirectAcquisition(body))
      if (body.backend === 'youtube') return send(response, 200, await acquireYouTube(body))
      if (body.backend === 'internet-archive') return send(response, 200, await acquireInternetArchive(body))
      if (body.backend === 'usenet') return send(response, 202, await queueUsenet(body))
      if (body.backend === 'torrent') return send(response, 202, await queueTorrent(body))
      throw new Error('Unsupported recovery backend.')
    }
    // Read-only: the job runner advances jobs, so asking for status never starts a download step or an import.
    if (request.url === '/v1/jobs/status') return send(response, 200, await pollUsenetJob.read(body.jobId))
    if (request.url === '/v1/jobs/cancel') return send(response, 200, await cancelRecoveryJob(body))
    if (request.url === '/v1/jobs/import-remaining') return send(response, 200, await importRemainingUsenet(body))
    if (request.url === '/v1/delete') return send(response, 200, await deleteImportedRecovery(body))
    if (request.url === '/v1/system/vpn/status') return send(response, 200, await vpn.status())
    if (request.url === '/v1/system/vpn') return send(response, 200, await vpn.change(body.action))
    if (request.url === '/v1/system/reboot') return send(response, 202, scheduleReboot(body, { config: reboot, spawn }))
    return send(response, 404, { error: 'not-found' })
  } catch (error) {
    const message = sanitizeToolError(error instanceof Error ? error.message : 'Recovery agent failed.', [youtubeCookies])
    return send(response, 400, { error: 'recovery-agent-error', message })
  }
}).listen(port, host, () => process.stdout.write(`Tomify recovery agent listening on http://${host}:${port}\n`))

await jobRunner.start()
