import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import { audioFormatSummary, sanitizeToolError, selectBestAudioFormat } from './youtube.mjs'
import { deleteRecoveryArtifacts } from './deletion.mjs'

const host = process.env.TOMIFY_RECOVERY_HOST || '127.0.0.1'
const port = Number(process.env.TOMIFY_RECOVERY_PORT || 8788)
const recoveryRoot = resolve(process.env.TOMIFY_RECOVERY_DIR || './recovered-music')
const masterRoot = process.env.TOMIFY_MASTER_DIR ? resolve(process.env.TOMIFY_MASTER_DIR) : null
const youtubeCookies = process.env.TOMIFY_YOUTUBE_COOKIES ? resolve(process.env.TOMIFY_YOUTUBE_COOKIES) : null
const token = process.env.TOMIFY_RECOVERY_TOKEN || ''
const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

if (masterRoot && (inside(recoveryRoot, masterRoot) || inside(masterRoot, recoveryRoot))) throw new Error('TOMIFY_RECOVERY_DIR must be separate from TOMIFY_MASTER_DIR.')
if (youtubeCookies && inside(youtubeCookies, recoveryRoot)) throw new Error('TOMIFY_YOUTUBE_COOKIES must be outside the recovery library.')

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

function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${basename(command)} timed out.`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8_000_000) child.kill('SIGKILL') })
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 2_000_000) child.kill('SIGKILL') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(`${basename(command)} failed: ${sanitizeToolError(stderr || `exit ${code}`, [youtubeCookies])}`))
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
  if (!token) return true
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
  if (!artist || !title) throw new Error('Artist and title are required.')
  const query = `${artist} ${title} official audio`
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

async function probe(path) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:stream=codec_type,codec_name,sample_rate,channels,bit_rate', '-of', 'json', path])
  const value = JSON.parse(stdout)
  const audio = (value.streams || []).find((stream) => stream.codec_type === 'audio') || {}
  return { codec: audio.codec_name || null, container: value.format?.format_name || extname(path).slice(1) || null, bitrate: Number(audio.bit_rate || value.format?.bit_rate) || null, sampleRate: Number(audio.sample_rate) || null, channels: Number(audio.channels) || null, duration: Number(value.format?.duration) || null }
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
    const extension = extname(sourcePath).toLowerCase() || '.mka'
    const artistDirectory = safeName(track.artist, 'Unknown Artist')
    const albumDirectory = safeName(track.album, 'Recovered Tracks')
    const prefix = Number.isInteger(track.trackNumber) && track.trackNumber > 0 ? `${String(track.trackNumber).padStart(2, '0')} - ` : ''
    const stem = `${prefix}${safeName(track.title, 'Recovered Track')}`
    const finalDirectory = resolve(recoveryRoot, artistDirectory, albumDirectory)
    const sourceDirectory = resolve(finalDirectory, '.tomify-source')
    const finalPath = resolve(finalDirectory, `${stem}${extension}`)
    const originalPath = resolve(sourceDirectory, `${stem}${extension}`)
    if (!inside(finalPath, recoveryRoot) || !inside(originalPath, recoveryRoot)) throw new Error('Unsafe recovery destination.')
    await mkdir(sourceDirectory, { recursive: true })
    for (const path of [finalPath, originalPath, `${finalPath}.tomify.json`]) {
      try { await access(path); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }

    const sourceQuality = await probe(sourcePath)
    const taggedPath = join(finalDirectory, `.${crypto.randomUUID()}${extension}`)
    const comment = `Tomify lossy recovery copy; source=${sourceUrl}; authorisation=${body.authorisation.basis}`
    const tags = ['-metadata', `artist=${track.artist || ''}`, '-metadata', `title=${track.title || ''}`, '-metadata', `album=${track.album || ''}`, '-metadata', `track=${track.trackNumber || ''}`, '-metadata', `disc=${track.discNumber || ''}`, '-metadata', `comment=${comment}`, '-metadata', 'TOMIFY_ARCHIVE_STATUS=lossy-recovery-copy', '-metadata', `TOMIFY_SOURCE_URL=${sourceUrl}`]
    try {
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', sourcePath, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'copy', ...tags, taggedPath], 5 * 60_000)
      const derivativeQuality = await probe(taggedPath)
      await copyFile(sourcePath, originalPath, fsConstants.COPYFILE_EXCL)
      try { await copyFile(taggedPath, finalPath, fsConstants.COPYFILE_EXCL) } catch (error) { await unlink(originalPath).catch(() => {}); throw error }
      const importedAt = new Date().toISOString()
      const provenance = {
        source: 'youtube', sourceUrl, videoId: String(metadata.id || body.candidate.externalId || ''), sourceTitle: String(metadata.title || body.candidate.title || ''),
        sourceChannel: String(metadata.channel || metadata.uploader || body.candidate.channel || ''), acquisitionMode: acquisition.authenticatedAccessUsed ? 'authenticated-youtube-session' : 'anonymous-youtube',
        authenticatedAccessUsed: acquisition.authenticatedAccessUsed, authenticationFallback: acquisition.authenticationFallback, selectedFormatId: String(selected.format_id),
        availableAudioFormats: formats.map(audioFormatSummary), acquiredAt: importedAt, rightsBasis: body.authorisation.basis,
        confirmedBy: body.authorisation.confirmedBy || null, confirmedAt: body.authorisation.confirmedAt || null, archiveStatus: 'lossy-recovery-copy',
        sourceAudio: { path: originalPath, quality: sourceQuality, preservedOriginal: true },
        derivative: { path: finalPath, createdByTomify: true, operation: 'ffmpeg-stream-copy-tagging', transcoded: false, quality: derivativeQuality },
      }
      await writeFile(`${finalPath}.tomify.json`, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' })
      return { path: finalPath, originalPath, quality: sourceQuality, derivative: provenance.derivative, provenance }
    } finally {
      await unlink(taggedPath).catch(() => {})
    }
  } finally {
    const resolvedTemporaryRoot = resolve(temporaryRoot)
    if (inside(resolvedTemporaryRoot, resolve(tmpdir())) && basename(resolvedTemporaryRoot).startsWith('tomify-recovery-')) await rm(resolvedTemporaryRoot, { recursive: true, force: true })
  }
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

await mkdir(recoveryRoot, { recursive: true })

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const auth = await cookieStatus()
      return send(response, 200, { ok: true, backends: ['youtube'], youtubeAuthentication: auth.usable ? 'configured' : 'not-configured' })
    }
    if (!authorised(request)) return send(response, 401, { error: 'unauthorized' })
    if (request.method !== 'POST') return send(response, 404, { error: 'not-found' })
    const body = await parseBody(request)
    if (request.url === '/v1/status') {
      const auth = await cookieStatus()
      return send(response, 200, { backends: [{ id: 'youtube', available: true, authentication: auth.usable ? 'configured' : 'not-configured' }] })
    }
    if (request.url === '/v1/diagnostics/youtube-auth') return send(response, 200, await diagnoseAuthenticatedYouTube())
    if (request.url === '/v1/search') return send(response, 200, { candidates: await searchYouTube(body.track) })
    if (request.url === '/v1/acquire') return send(response, 200, await acquireYouTube(body))
    if (request.url === '/v1/delete') return send(response, 200, await deleteImportedRecovery(body))
    return send(response, 404, { error: 'not-found' })
  } catch (error) {
    const message = sanitizeToolError(error instanceof Error ? error.message : 'Recovery agent failed.', [youtubeCookies])
    return send(response, 400, { error: 'recovery-agent-error', message })
  }
}).listen(port, host, () => process.stdout.write(`Tomify recovery agent listening on http://${host}:${port}\n`))
