import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { timingSafeEqual } from 'node:crypto'

const host = process.env.TOMIFY_RECOVERY_HOST || '127.0.0.1'
const port = Number(process.env.TOMIFY_RECOVERY_PORT || 8788)
const recoveryRoot = resolve(process.env.TOMIFY_RECOVERY_DIR || './recovered-music')
const masterRoot = process.env.TOMIFY_MASTER_DIR ? resolve(process.env.TOMIFY_MASTER_DIR) : null
const token = process.env.TOMIFY_RECOVERY_TOKEN || ''
const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

if (masterRoot && (inside(recoveryRoot, masterRoot) || inside(masterRoot, recoveryRoot))) {
  throw new Error('TOMIFY_RECOVERY_DIR must be separate from TOMIFY_MASTER_DIR.')
}

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
      else reject(new Error(`${basename(command)} failed: ${stderr.trim().slice(-600) || `exit ${code}`}`))
    })
  })
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
  const { stdout } = await run(ytdlp, ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', `ytsearch8:${query}`])
  const result = JSON.parse(stdout)
  const entries = Array.isArray(result.entries) ? result.entries : []
  return entries.filter(Boolean).map((entry) => ({
    externalId: String(entry.id || ''),
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(String(entry.id || ''))}`,
    title: String(entry.title || ''),
    channel: String(entry.channel || entry.uploader || 'Unknown channel'),
    channelId: entry.channel_id || entry.uploader_id || null,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    thumbnail: entry.thumbnail || null,
    provenance: { extractor: entry.extractor_key || entry.extractor || 'YouTube', availability: entry.availability || 'public' },
  })).filter((entry) => entry.externalId)
}

async function probe(path) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:stream=codec_type,codec_name,sample_rate,channels,bit_rate', '-of', 'json', path])
  const value = JSON.parse(stdout)
  const audio = (value.streams || []).find((stream) => stream.codec_type === 'audio') || {}
  return {
    codec: audio.codec_name || null,
    container: value.format?.format_name || extname(path).slice(1) || null,
    bitrate: Number(audio.bit_rate || value.format?.bit_rate) || null,
    sampleRate: Number(audio.sample_rate) || null,
    channels: Number(audio.channels) || null,
    duration: Number(value.format?.duration) || null,
  }
}

async function acquireYouTube(body) {
  if (body?.authorisation?.confirmed !== true || !body.authorisation.basis) throw new Error('Explicit source authorisation is required.')
  const sourceUrl = youtubeUrl(body?.candidate?.url)
  const track = body?.track || {}
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tomify-recovery-'))
  try {
    const outputTemplate = join(temporaryRoot, 'source.%(ext)s')
    const { stdout } = await run(ytdlp, ['--ignore-config', '--no-playlist', '--no-overwrites', '--no-warnings', '-f', 'bestaudio/best', '--print', 'after_move:filepath', '-o', outputTemplate, sourceUrl], 10 * 60_000)
    const sourcePath = resolve(stdout.split(/\r?\n/).filter(Boolean).at(-1) || '')
    if (!inside(sourcePath, temporaryRoot)) throw new Error('Downloader returned an unexpected file path.')
    await access(sourcePath, fsConstants.R_OK)

    const extension = extname(sourcePath).toLowerCase() || '.mka'
    const artistDirectory = safeName(track.artist, 'Unknown Artist')
    const albumDirectory = safeName(track.album, 'Recovered Tracks')
    const prefix = Number.isInteger(track.trackNumber) && track.trackNumber > 0 ? `${String(track.trackNumber).padStart(2, '0')} - ` : ''
    const fileName = `${prefix}${safeName(track.title, 'Recovered Track')}${extension}`
    const finalDirectory = resolve(recoveryRoot, artistDirectory, albumDirectory)
    const finalPath = resolve(finalDirectory, fileName)
    if (!inside(finalPath, recoveryRoot)) throw new Error('Unsafe recovery destination.')
    await mkdir(finalDirectory, { recursive: true })
    try { await access(finalPath); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }

    const taggedPath = join(finalDirectory, `.${crypto.randomUUID()}${extension}`)
    const comment = `Tomify lossy recovery copy; source=${sourceUrl}; authorisation=${body.authorisation.basis}`
    const metadata = ['-metadata', `artist=${track.artist || ''}`, '-metadata', `title=${track.title || ''}`, '-metadata', `album=${track.album || ''}`, '-metadata', `track=${track.trackNumber || ''}`, '-metadata', `disc=${track.discNumber || ''}`, '-metadata', `comment=${comment}`, '-metadata', 'TOMIFY_ARCHIVE_STATUS=lossy-recovery-copy', '-metadata', `TOMIFY_SOURCE_URL=${sourceUrl}`]
    try {
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', sourcePath, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'copy', ...metadata, taggedPath], 5 * 60_000)
      await copyFile(taggedPath, finalPath, fsConstants.COPYFILE_EXCL)
    } finally {
      await unlink(taggedPath).catch(() => {})
    }

    const quality = await probe(finalPath)
    const provenance = {
      source: 'youtube', sourceUrl, sourceId: body.candidate.externalId || null, sourceTitle: body.candidate.title || null,
      sourceChannel: body.candidate.channel || null, rightsBasis: body.authorisation.basis, confirmedBy: body.authorisation.confirmedBy || null,
      confirmedAt: body.authorisation.confirmedAt || null, importedAt: new Date().toISOString(), archiveStatus: 'lossy-recovery-copy', quality,
    }
    await writeFile(`${finalPath}.tomify.json`, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' })
    return { path: finalPath, quality, provenance }
  } finally {
    const resolvedTemporaryRoot = resolve(temporaryRoot)
    if (inside(resolvedTemporaryRoot, resolve(tmpdir())) && basename(resolvedTemporaryRoot).startsWith('tomify-recovery-')) await rm(resolvedTemporaryRoot, { recursive: true, force: true })
  }
}

await mkdir(recoveryRoot, { recursive: true })

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true, backends: ['youtube'], recoveryRoot })
    if (!authorised(request)) return send(response, 401, { error: 'unauthorized' })
    if (request.method !== 'POST') return send(response, 404, { error: 'not-found' })
    const body = await parseBody(request)
    if (request.url === '/v1/search') return send(response, 200, { candidates: await searchYouTube(body.track) })
    if (request.url === '/v1/acquire') return send(response, 200, await acquireYouTube(body))
    return send(response, 404, { error: 'not-found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Recovery agent failed.'
    return send(response, 400, { error: 'recovery-agent-error', message })
  }
}).listen(port, host, () => process.stdout.write(`Tomify recovery agent listening on http://${host}:${port}\nRecovery copies: ${recoveryRoot}\n`))
