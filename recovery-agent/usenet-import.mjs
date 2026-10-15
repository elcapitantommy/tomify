import { constants as fsConstants } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildArtworkProvenance, buildDerivativeArguments } from './artwork.mjs'
import { recoveryDerivativeExtension, recoveryDerivativeOperation } from './derivative.mjs'
import { ffmpegMetadataArguments } from './metadata.mjs'
import { selectCompletedAudio } from './usenet.mjs'

function text(value) { return String(value ?? '').trim() }
function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }
function safeName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 120)
  return cleaned || fallback
}
function numericTag(value) {
  const match = text(value).match(/^\s*(\d{1,4})(?:\s*\/\s*\d+)?/)
  const parsed = match ? Number(match[1]) : null
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
function sourceTags(quality) {
  const normalized = {}
  for (const [key, value] of Object.entries(quality?.tags || {})) {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (name && text(value) && normalized[name] === undefined) normalized[name] = text(value)
  }
  return normalized
}
function filenameMetadata(path, fallbackTrackNumber) {
  const extension = extname(path)
  const raw = basename(path, extension).trim()
  const discTrack = raw.match(/^\s*(\d{1,2})[-_.](\d{1,3})\s*[-_. ]+(.+)$/)
  if (discTrack) return { title: discTrack[3].trim(), discNumber: Number(discTrack[1]), trackNumber: Number(discTrack[2]) }
  const track = raw.match(/^\s*(\d{1,3})\s*[-_. ]+(.+)$/)
  if (track) return { title: track[2].trim(), discNumber: null, trackNumber: Number(track[1]) }
  return { title: raw || `Track ${fallbackTrackNumber}`, discNumber: null, trackNumber: fallbackTrackNumber }
}
function mostCommon(values) {
  const counts = new Map()
  for (const value of values.map(text).filter(Boolean)) {
    const key = value.toLocaleLowerCase('en')
    const current = counts.get(key) || { value, count: 0 }
    current.count += 1
    counts.set(key, current)
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))[0]?.value || null
}

export function releaseTrackMetadata(sourcePath, quality, releaseFallback, fallbackTrackNumber) {
  const tags = sourceTags(quality)
  const filename = filenameMetadata(sourcePath, fallbackTrackNumber)
  return {
    artist: tags.artist || releaseFallback.artist || null,
    albumArtist: tags.albumartist || tags.albumartists || tags.artist || releaseFallback.artist || null,
    album: tags.album || releaseFallback.album || null,
    title: tags.title || filename.title,
    trackNumber: numericTag(tags.tracknumber || tags.track) || filename.trackNumber,
    discNumber: numericTag(tags.discnumber || tags.disc) || filename.discNumber,
    releaseDate: tags.date || tags.year || releaseFallback.releaseDate || null,
    releaseId: releaseFallback.releaseId || null,
    releaseGroupId: releaseFallback.releaseGroupId || null,
    recordingId: null,
    isrc: null,
  }
}

export function selectUsenetImportFiles(files, track, searchMode) {
  const ordered = [...files].sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }))
  if (searchMode === 'release') return ordered
  const selected = selectCompletedAudio(ordered, track)
  return selected ? [selected] : []
}

async function matchingDirectory(parent, requested, fallback, canonicalRoot) {
  const name = safeName(requested, fallback)
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en')).map((entry) => entry.name)
  const selected = directories.includes(name) ? name : directories.sort((left, right) => left.localeCompare(right, 'en'))[0] || name
  const result = resolve(parent, selected)
  if (!inside(result, resolve(parent))) throw new Error('Unsafe recovery destination.')
  await mkdir(result, { recursive: true })
  const canonical = await realpath(result)
  if (!inside(canonical, canonicalRoot)) throw new Error('Unsafe recovery destination.')
  return canonical
}

export async function resolveReleaseDirectory(recoveryRoot, artist, album) {
  const root = resolve(recoveryRoot)
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  const artistDirectory = await matchingDirectory(canonicalRoot, artist, 'Unknown Artist', canonicalRoot)
  const albumDirectory = await matchingDirectory(artistDirectory, album, 'Recovered Tracks', canonicalRoot)
  return albumDirectory
}

async function ensureAbsent(paths) {
  for (const path of paths) {
    try { await access(path); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

export async function importUsenetCompletion(job, completedFiles, options) {
  const { recoveryRoot, probe, prepareArtwork, run, ffmpeg } = options
  const searchMode = job.result.searchMode || 'track'
  const selectedFiles = selectUsenetImportFiles(completedFiles, job.request.track || {}, searchMode)
  if (!selectedFiles.length) throw new Error('No completed audio file matched the wanted track.')
  const inspected = []
  for (const [index, file] of selectedFiles.entries()) {
    const quality = await probe(file.path)
    if (!quality.codec || !quality.duration) {
      if (searchMode === 'release') continue
      throw new Error('The selected completed file is not valid audio.')
    }
    inspected.push({ file, quality, metadata: searchMode === 'release' ? releaseTrackMetadata(file.path, quality, job.request.track || {}, index + 1) : { ...(job.request.track || {}) } })
  }
  if (!inspected.length) throw new Error('The completed Usenet download contains no valid supported audio files.')

  const releaseArtist = searchMode === 'release' ? mostCommon(inspected.map((item) => item.metadata.albumArtist || item.metadata.artist)) || job.request.track?.artist : job.request.track?.artist
  const releaseAlbum = searchMode === 'release' ? mostCommon(inspected.map((item) => item.metadata.album)) || job.request.track?.album : job.request.track?.album
  const finalDirectory = await resolveReleaseDirectory(recoveryRoot, releaseArtist, releaseAlbum)
  const canonicalRecoveryRoot = await realpath(resolve(recoveryRoot))
  let sourceDirectory = resolve(finalDirectory, '.tomify-source')
  if (!inside(sourceDirectory, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')
  await mkdir(sourceDirectory, { recursive: true })
  if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error('Unsafe recovery destination.')
  sourceDirectory = await realpath(sourceDirectory)
  if (!inside(sourceDirectory, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')

  const discNumbers = new Set(inspected.map((item) => item.metadata.discNumber).filter((value) => Number.isInteger(value) && value > 0))
  const includeDiscInStem = discNumbers.size > 1 || [...discNumbers].some((value) => value > 1)
  const plans = inspected.map((item, index) => {
    const sourceExtension = extname(item.file.path).toLowerCase() || '.mka'
    const derivativeExtension = recoveryDerivativeExtension(item.file.path, item.quality)
    const trackPrefix = Number.isInteger(item.metadata.trackNumber) && item.metadata.trackNumber > 0 ? String(item.metadata.trackNumber).padStart(2, '0') : ''
    const discPrefix = includeDiscInStem && Number.isInteger(item.metadata.discNumber) && item.metadata.discNumber > 0 ? `${String(item.metadata.discNumber).padStart(2, '0')}-` : ''
    const prefix = trackPrefix ? `${discPrefix}${trackPrefix} - ` : ''
    const stem = `${prefix}${safeName(item.metadata.title, basename(item.file.path, sourceExtension))}`
    const finalPath = resolve(finalDirectory, `${stem}${derivativeExtension}`)
    const originalPath = resolve(sourceDirectory, `${stem}${sourceExtension}`)
    if (!inside(finalPath, canonicalRecoveryRoot) || !inside(originalPath, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')
    return { ...item, index, sourceExtension, derivativeExtension, finalPath, originalPath, sidecarPath: `${finalPath}.tomify.json` }
  })
  const destinations = plans.flatMap((plan) => [plan.finalPath, plan.originalPath, plan.sidecarPath])
  if (new Set(destinations.map((path) => path.toLocaleLowerCase('en'))).size !== destinations.length) throw new Error('The completed release contains duplicate destination track names.')
  await ensureAbsent(destinations)

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tomify-recovery-'))
  const committed = []
  const importedTracks = []
  const releaseCoverPath = resolve(finalDirectory, 'cover.jpg')
  let coverCreated = false
  try {
    const artwork = await prepareArtwork(job.request.artwork, temporaryRoot)
    const providerType = job.indexer.type || 'newznab'
    const sourceUrl = job.result.detailsUrl || `${providerType}:${job.indexer.id}:${job.result.externalId || 'result'}`
    const acquiredAt = new Date().toISOString()
    for (const plan of plans) {
      const taggedPath = join(finalDirectory, `.${randomUUID()}${plan.derivativeExtension}`)
      try {
        const comment = `Tomify authorised Usenet recovery copy; provider=${job.indexer.name}; authorisation=${job.request.authorisation.basis}`
        const tags = ffmpegMetadataArguments({ ...plan.metadata, sourceUrl }, comment)
        const derivativePlan = buildDerivativeArguments({ sourcePath: plan.file.path, outputPath: taggedPath, coverPath: artwork?.coverPath || null, tags })
        await run(ffmpeg, derivativePlan.args, 5 * 60_000)
        const derivativeQuality = await probe(taggedPath)
        await copyFile(plan.file.path, plan.originalPath, fsConstants.COPYFILE_EXCL); committed.push(plan.originalPath)
        await copyFile(taggedPath, plan.finalPath, fsConstants.COPYFILE_EXCL); committed.push(plan.finalPath)
        const artworkProvenance = buildArtworkProvenance(artwork, derivativePlan, releaseCoverPath)
        const provenance = {
          source: 'usenet', sourceUrl, providerType, providerName: job.indexer.name, providerId: job.indexer.id, providerResultId: job.result.resultId || job.result.externalId, postedTitle: job.result.title, detailsUrl: job.result.detailsUrl,
          searchMode, postedAt: job.result.postedAt, postedSize: job.result.size, ageDaysAtDiscovery: job.result.ageDays, downloader: job.downloader,
          ...(providerType === 'newznab' ? { newznabProvider: job.indexer.name, newznabResultId: job.result.externalId, newznabTitle: job.result.title } : {}),
          completedFileCount: completedFiles.length, acquiredAt, rightsBasis: job.request.authorisation.basis,
          confirmedBy: job.request.authorisation.confirmedBy || null, confirmedAt: job.request.authorisation.confirmedAt || null,
          archiveStatus: 'usenet-recovery-copy', wantedMetadata: job.request.wantedMetadata, resolvedMetadata: plan.metadata,
          catalogueSource: job.request.catalogueSource, metadataResolution: job.request.metadataResolution, artwork: artworkProvenance,
          releaseImport: { multiTrack: searchMode === 'release', acquisitionId: job.id, importedTrackNumber: plan.index + 1, importedTrackCount: plans.length, artist: releaseArtist || null, album: releaseAlbum || null },
          sourceAudio: { path: plan.originalPath, extension: plan.sourceExtension, quality: plan.quality, preservedOriginal: true },
          derivative: { path: plan.finalPath, extension: plan.derivativeExtension, containerRemuxed: plan.sourceExtension !== plan.derivativeExtension, createdByTomify: true, operation: recoveryDerivativeOperation(plan.sourceExtension, plan.derivativeExtension, derivativePlan.embedded), audioStreamCopied: true, transcoded: false, quality: derivativeQuality },
        }
        await writeFile(plan.sidecarPath, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' }); committed.push(plan.sidecarPath)
        importedTracks.push({ path: plan.finalPath, originalPath: plan.originalPath, artist: plan.metadata.artist || null, albumArtist: plan.metadata.albumArtist || null, album: plan.metadata.album || null, title: plan.metadata.title, trackNumber: plan.metadata.trackNumber || null, discNumber: plan.metadata.discNumber || null, quality: plan.quality, derivative: provenance.derivative, artwork: artworkProvenance, provenance })
      } finally {
        await unlink(taggedPath).catch(() => {})
      }
    }
    if (artwork) {
      try { await access(releaseCoverPath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        const stagedCoverPath = join(finalDirectory, `.${randomUUID()}.cover.jpg`)
        try { await copyFile(artwork.coverPath, stagedCoverPath, fsConstants.COPYFILE_EXCL); await rename(stagedCoverPath, releaseCoverPath); coverCreated = true } finally { await unlink(stagedCoverPath).catch(() => {}) }
      }
    }
    const first = importedTracks[0]
    return { ...first, importedCount: importedTracks.length, importedTracks, artist: releaseArtist || null, album: releaseAlbum || null, artwork: first.artwork, sourceFiles: plans.map((plan) => plan.file.path) }
  } catch (error) {
    for (const path of committed.reverse()) await unlink(path).catch(() => {})
    if (coverCreated) await unlink(releaseCoverPath).catch(() => {})
    throw error
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

// Downloaded files a completed job has already imported. Jobs from before sourceFiles was recorded
// fall back to re-running the first import's deterministic file selection.
export function importedUsenetSourceFiles(job, completedFiles) {
  const recorded = [job.importResult, ...(job.additionalImports || [])].flatMap((result) => Array.isArray(result?.sourceFiles) ? result.sourceFiles : [])
  if (Array.isArray(job.importResult?.sourceFiles)) return new Set(recorded)
  const firstImport = selectUsenetImportFiles(completedFiles, job.request?.track || {}, job.result?.searchMode || 'track')
  return new Set([...recorded, ...firstImport.map((file) => file.path)])
}

// Imports the audio files a single-track Usenet job left behind, as a release, without downloading again.
export async function importRemainingUsenetFiles(job, completedFiles, options) {
  if (job.status !== 'completed') throw new Error('Only a completed Usenet download can have its remaining files imported.')
  if ((job.result?.searchMode || 'track') === 'release') throw new Error('This download was already imported as a whole release.')
  const imported = importedUsenetSourceFiles(job, completedFiles)
  const remaining = completedFiles.filter((file) => !imported.has(file.path))
  if (!remaining.length) throw new Error('Every audio file in this download has already been imported.')
  return importUsenetCompletion({ ...job, result: { ...job.result, searchMode: 'release' } }, remaining, options)
}
