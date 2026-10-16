import { access, lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildArtworkProvenance, buildDerivativeArguments } from './artwork.mjs'
import { recoveryDerivativeExtension, recoveryDerivativeOperation } from './derivative.mjs'
import { ffmpegMetadataArguments } from './metadata.mjs'
import { selectCompletedAudio } from './usenet.mjs'
import { foldName, preferRequestedName } from './text-encoding.mjs'
import { cleanupCompletedDownload } from './commit.mjs'
import { prepareImportStaging, removeImportStaging, runManifestImport, sha256File } from './manifest.mjs'
import { existingTrackMatcher } from './preflight.mjs'

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

// The album a file's folder names, for releases whose files carry no album tag. A "CD1" or "Disc 2" folder
// names the disc, and its parent names the album.
export function folderAlbum(path) {
  let directory = dirname(path)
  const disc = basename(directory).match(/^(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})$/i)
  if (disc) directory = dirname(directory)
  let album = basename(directory).trim()
  // Drop trailing format notes such as "[FLAC]" or "(FLAC 24bit)"; they are not part of the album title.
  for (let previous = ''; previous !== album;) { previous = album; album = album.replace(/\s*[[(][^\])]*\b(?:flac|mp3|alac|aac|ogg|opus|wav|lossless|\d+\s*kbps|\d+\s*bit|web)\b[^\])]*[\])]$/i, '').trim() }
  return { album: album || null, discNumber: disc ? Number(disc[1]) : null }
}

// Compares artist names ignoring case, accents, punctuation, "&" versus "and" and a leading "The", so
// "Earth, Wind & Fire", "Earth Wind And Fire" and "Earth, Wind, and Fire" are one artist.
export function looseArtistKey(value) {
  return foldName(value).replace(/&/g, ' and ').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^the /, '').replace(/ /g, '')
}

// One spelling for the release's own artist across every track, so Navidrome lists a discography whose tags
// spell the band several ways as one artist. Prefers the spelling of an artist folder already in the master
// library, then the release's most common spelling. Other artists (guests, collaborations) are left as tagged.
export async function unifyReleaseArtist(inspected, requested, masterRoot) {
  const names = inspected.flatMap((item) => [item.metadata.albumArtist, item.metadata.artist]).filter(Boolean)
  const key = looseArtistKey(requested.artist || mostCommon(inspected.map((item) => item.metadata.albumArtist || item.metadata.artist)))
  if (!key) return null
  const libraryNames = masterRoot ? (await readdir(masterRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []
  const canonical = libraryNames.filter((name) => looseArtistKey(name) === key).sort((left, right) => left.localeCompare(right, 'en'))[0]
    || mostCommon(names.filter((name) => looseArtistKey(name) === key))
    || requested.artist
  for (const item of inspected) {
    const metadata = { ...item.metadata }
    if (looseArtistKey(metadata.albumArtist) === key) metadata.albumArtist = canonical
    if (looseArtistKey(metadata.artist) === key) metadata.artist = canonical
    item.metadata = metadata
  }
  return canonical
}

// The album artist for one album of a release. An album-artist tag wins. Without one, a track's artist is often
// a guest or featured name ("Deniece Williams" on a compilation), so the release's own artist is used when it
// appears on the album, then an artist on more than half its tracks, then "Various Artists".
export function albumArtistFor(items, releaseArtist) {
  const tagged = mostCommon(items.filter((item) => item.hasAlbumArtistTag).map((item) => item.metadata.albumArtist))
  if (tagged) return tagged
  const key = looseArtistKey(releaseArtist)
  if (key && items.some((item) => looseArtistKey(item.metadata.artist) === key)) return releaseArtist
  const common = mostCommon(items.map((item) => item.metadata.artist))
  if (!common) return null
  const count = items.filter((item) => looseArtistKey(item.metadata.artist) === looseArtistKey(common)).length
  return count * 2 > items.length || items.length === 1 ? common : 'Various Artists'
}

// Splits a release into one group per album, so a discography imports into one folder per album rather than
// mixing every album's tracks (and their clashing "01 - Intro" names) into one. Files with no album tag fall
// back to their folder's name when the release spans several folders.
export function releaseAlbumGroups(inspected, requested, releaseArtist = null) {
  const folders = inspected.map((item) => folderAlbum(item.file.path))
  const multipleFolders = new Set(folders.map((folder) => foldName(folder.album || ''))).size > 1
  const groups = new Map()
  for (const [index, item] of inspected.entries()) {
    if (multipleFolders && !item.hasAlbumTag && folders[index].album) {
      item.metadata = { ...item.metadata, album: folders[index].album, discNumber: item.metadata.discNumber || folders[index].discNumber }
    }
    const key = foldName(item.metadata.album || '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const requestedAlbum = foldName(requested.album || '')
  const list = [...groups.entries()].map(([key, items]) => ({
    items,
    artist: albumArtistFor(items, releaseArtist) || requested.artist,
    album: mostCommon(items.map((item) => item.metadata.album)) || requested.album || null,
    requested: groups.size === 1 || (Boolean(requestedAlbum) && key === requestedAlbum),
  }))
  // Navidrome splits an album whose tracks name different album artists, so every track gets its album's one.
  for (const group of list) {
    for (const item of group.items) item.metadata = { ...item.metadata, albumArtist: group.artist || item.metadata.albumArtist }
  }
  // MusicBrainz release ids and dates from the wanted item only describe the wanted album.
  for (const group of list.filter((value) => !value.requested)) {
    for (const item of group.items) item.metadata = { ...item.metadata, releaseId: null, releaseGroupId: null, releaseDate: item.hasDateTag ? item.metadata.releaseDate : null }
  }
  return list
}

export function releaseTrackMetadata(sourcePath, quality, releaseFallback, fallbackTrackNumber) {
  const tags = sourceTags(quality)
  const filename = filenameMetadata(sourcePath, fallbackTrackNumber)
  return {
    artist: preferRequestedName(tags.artist, releaseFallback.artist),
    albumArtist: preferRequestedName(tags.albumartist || tags.albumartists || tags.artist, releaseFallback.artist),
    album: preferRequestedName(tags.album, releaseFallback.album),
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

function titleSimilarity(left, right) {
  const a = foldName(left).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const b = foldName(right).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.9
  const leftTokens = new Set(a.split(/\s+/))
  const rightTokens = new Set(b.split(/\s+/))
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  return shared * 2 / (leftTokens.size + rightTokens.size)
}

function canonicalTrackMetadata(track, tracklist) {
  return {
    artist: track.artist || tracklist.artist || null,
    albumArtist: tracklist.artist || track.artist || null,
    album: tracklist.title || null,
    title: track.title,
    trackNumber: track.number,
    discNumber: track.disc,
    releaseDate: tracklist.date || null,
    releaseId: tracklist.releaseId || null,
    releaseGroupId: tracklist.releaseGroupId || null,
    recordingId: track.recordingId || null,
    isrc: track.isrc || null,
  }
}

// Maps each valid downloaded audio file to at most one canonical MusicBrainz track. Position tags win;
// title plus duration is the fallback for bad/missing positions, then filename positions are tried last.
export function mapReleaseTracklist(inspected, tracklist) {
  const tracks = (Array.isArray(tracklist?.tracks) ? tracklist.tracks : []).filter((track) => Number.isInteger(Number(track?.disc)) && Number(track.disc) > 0 && Number.isInteger(Number(track?.number)) && Number(track.number) > 0 && text(track?.title))
  const remaining = new Set(tracks)
  const matched = new Map()
  const position = (disc, number) => {
    if (!Number.isInteger(number) || number < 1) return null
    const candidates = [...remaining].filter((track) => Number(track.number) === number && (!disc || Number(track.disc) === disc))
    return candidates.length === 1 ? candidates[0] : null
  }
  const assign = (item, track) => {
    if (!track || matched.has(item) || !remaining.has(track)) return false
    remaining.delete(track)
    matched.set(item, track)
    return true
  }

  for (const item of inspected) {
    const tags = sourceTags(item.quality)
    const number = numericTag(tags.tracknumber || tags.track)
    const disc = numericTag(tags.discnumber || tags.disc)
    assign(item, position(disc, number))
  }
  for (const item of inspected.filter((value) => !matched.has(value))) {
    const candidates = [...remaining].filter((track) => Number.isFinite(Number(track.length)) && Number.isFinite(Number(item.quality?.duration)) && Math.abs(Number(track.length) - Number(item.quality.duration)) <= 3)
      .map((track) => ({ track, score: titleSimilarity(item.metadata.title, track.title) }))
      .filter((candidate) => candidate.score >= 0.65)
      .sort((left, right) => right.score - left.score || Number(left.track.disc) - Number(right.track.disc) || Number(left.track.number) - Number(right.track.number))
    if (candidates.length && (candidates.length === 1 || candidates[0].score > candidates[1].score)) assign(item, candidates[0].track)
  }
  for (const item of inspected.filter((value) => !matched.has(value))) {
    const filename = filenameMetadata(item.file.path, null)
    assign(item, position(filename.discNumber, filename.trackNumber))
  }

  const items = inspected.filter((item) => matched.has(item)).map((item) => ({ ...item, metadata: canonicalTrackMetadata(matched.get(item), tracklist), tracklistTrack: matched.get(item) }))
  const extraFiles = inspected.filter((item) => !matched.has(item)).map((item) => ({ path: item.file.path, name: item.file.name, title: item.metadata.title || null, duration: Number(item.quality?.duration) || null }))
  const missingTracks = tracks.filter((track) => remaining.has(track)).map((track) => ({ key: track.key || `${track.disc}-${track.number}`, disc: Number(track.disc), number: Number(track.number), title: track.title, artist: track.artist || tracklist.artist || null, recordingId: track.recordingId || null, isrc: track.isrc || null }))
  return { items, completeness: { matched: items.length, total: tracks.length, missingTracks, extraFiles } }
}

export function selectUsenetImportFiles(files, track, searchMode) {
  const ordered = [...files].sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }))
  if (searchMode === 'release') return ordered
  const selected = selectCompletedAudio(ordered, track)
  return selected ? [selected] : []
}

async function matchingDirectory(parent, requested, fallback, canonicalRoot) {
  const name = safeName(requested, fallback).normalize('NFC')
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
  const directories = entries.filter((entry) => entry.isDirectory() && foldName(entry.name.normalize('NFC')) === foldName(name)).map((entry) => entry.name)
  const exact = directories.find((directory) => directory.normalize('NFC') === name)
  const selected = exact || directories.sort((left, right) => left.localeCompare(right, 'en'))[0] || name
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

export async function planDestination(recoveryRoot, track, sourceExtension, derivativeExtension) {
  const root = resolve(recoveryRoot)
  const finalDirectory = await resolveReleaseDirectory(root, track?.artist, track?.album)
  const canonicalRoot = await realpath(root)
  const sourceDirectory = resolve(finalDirectory, '.tomify-source')
  const prefix = Number.isInteger(track?.trackNumber) && track.trackNumber > 0 ? `${String(track.trackNumber).padStart(2, '0')} - ` : ''
  const stem = `${prefix}${safeName(track?.title, 'Recovered Track').normalize('NFC')}`
  const finalPath = resolve(finalDirectory, `${stem}${derivativeExtension}`)
  const originalPath = resolve(sourceDirectory, `${stem}${sourceExtension}`)
  if (!inside(finalPath, canonicalRoot) || !inside(originalPath, canonicalRoot)) throw new Error('Unsafe recovery destination.')
  return { finalDirectory, sourceDirectory, finalPath, originalPath }
}

async function sameFileContents(left, right) {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)])
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false
  return await sha256File(left) === await sha256File(right)
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

// Whether a recovery copy already uses this name: 'absent', 'same' (its preserved original is this very file) or 'other'.
async function existingRecoveryCopy(finalPath, originalPath, sourcePath) {
  const exists = async (path) => { try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
  if (!(await exists(finalPath)) && !(await exists(originalPath)) && !(await exists(`${finalPath}.tomify.json`))) return 'absent'
  return await exists(originalPath) && await exists(finalPath) && await sameFileContents(originalPath, sourcePath) ? 'same' : 'other'
}

async function ensureAbsent(paths) {
  for (const path of paths) {
    try { await access(path); throw new Error('A recovery copy already exists; Tomify will not overwrite it.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

export async function importUsenetCompletion(job, completedFiles, options) {
  const { recoveryRoot, masterRoot = null, probe, prepareArtwork, run, ffmpeg } = options
  const searchMode = job.result.searchMode || 'track'
  const selectedFiles = selectUsenetImportFiles(completedFiles, job.request.track || {}, searchMode)
  if (!selectedFiles.length) throw new Error('No completed audio file matched the wanted track.')
  let inspected = []
  for (const [index, file] of selectedFiles.entries()) {
    const quality = await probe(file.path)
    if (!quality.codec || !quality.duration) {
      if (searchMode === 'release') continue
      throw new Error('The selected completed file is not valid audio.')
    }
    const tags = sourceTags(quality)
    inspected.push({ file, quality, hasAlbumTag: Boolean(tags.album), hasAlbumArtistTag: Boolean(tags.albumartist || tags.albumartists), hasDateTag: Boolean(tags.date || tags.year), metadata: searchMode === 'release' ? releaseTrackMetadata(file.path, quality, job.request.track || {}, index + 1) : { ...(job.request.track || {}) } })
  }
  const torrent = job.downloader === 'qbittorrent'
  if (!inspected.length) throw new Error(`The completed ${torrent ? 'torrent' : 'Usenet download'} contains no valid supported audio files.`)

  const tracklist = searchMode === 'release' && Array.isArray(job.request?.tracklist?.tracks) && job.request.tracklist.tracks.length ? job.request.tracklist : null
  let completeness = null
  if (tracklist) {
    const mapped = mapReleaseTracklist(inspected, tracklist)
    inspected = mapped.items
    completeness = mapped.completeness
    if (!inspected.length) throw new Error('No downloaded audio file matched the MusicBrainz tracklist.')
  }
  const unifiedArtist = searchMode === 'release' && !tracklist ? await unifyReleaseArtist(inspected, job.request.track || {}, masterRoot) : tracklist?.artist || null
  const groups = tracklist
    ? [{ items: inspected, artist: tracklist.artist || job.request.track?.artist, album: tracklist.title || job.request.track?.album, requested: true }]
    : searchMode === 'release' ? releaseAlbumGroups(inspected, job.request.track || {}, unifiedArtist) : [{ items: inspected, artist: job.request.track?.artist, album: job.request.track?.album, requested: true }]
  const releaseArtist = tracklist?.artist || (searchMode === 'release' ? mostCommon(inspected.map((item) => item.metadata.albumArtist || item.metadata.artist)) || job.request.track?.artist : job.request.track?.artist)
  const releaseAlbum = groups.length === 1 ? groups[0].album : null
  await mkdir(resolve(recoveryRoot), { recursive: true })
  const canonicalRecoveryRoot = await realpath(resolve(recoveryRoot))
  const plans = []
  const alreadyPresent = []
  const skippedExisting = []
  // skipExisting (duplicate preflight): a release leaves out tracks its destination already holds.
  const skipExisting = searchMode === 'release' && job.request?.skipExisting === true
  const usedStems = new Set()
  for (const group of groups) {
    const finalDirectory = await resolveReleaseDirectory(recoveryRoot, group.artist, group.album)
    let sourceDirectory = resolve(finalDirectory, '.tomify-source')
    if (!inside(sourceDirectory, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')
    await mkdir(sourceDirectory, { recursive: true })
    if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error('Unsafe recovery destination.')
    sourceDirectory = await realpath(sourceDirectory)
    if (!inside(sourceDirectory, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')
    group.finalDirectory = finalDirectory
    const alreadyInDestination = skipExisting ? await existingTrackMatcher(finalDirectory, { probe }) : null

    const discNumbers = new Set(group.items.map((item) => item.metadata.discNumber).filter((value) => Number.isInteger(value) && value > 0))
    const includeDiscInStem = discNumbers.size > 1 || [...discNumbers].some((value) => value > 1)
    for (const item of group.items) {
      if (alreadyInDestination?.(item.metadata, item.quality)) { skippedExisting.push(item.file.path); continue }
      const sourceExtension = extname(item.file.path).toLowerCase() || '.mka'
      const derivativeExtension = recoveryDerivativeExtension(item.file.path, item.quality)
      const trackPrefix = Number.isInteger(item.metadata.trackNumber) && item.metadata.trackNumber > 0 ? String(item.metadata.trackNumber).padStart(2, '0') : ''
      const discPrefix = includeDiscInStem && Number.isInteger(item.metadata.discNumber) && item.metadata.discNumber > 0 ? `${String(item.metadata.discNumber).padStart(2, '0')}-` : ''
      const prefix = trackPrefix ? `${discPrefix}${trackPrefix} - ` : ''
      const baseStem = `${prefix}${safeName(item.metadata.title, basename(item.file.path, sourceExtension))}`
      // Two files that still land on the same name (a repeated track, or two copies of one album) are both kept.
      // In a release, a name already used in the recovery library is skipped when it holds this same file (an
      // album recovered before) and otherwise moves to the next free name, so one clash never fails the import.
      let stem = baseStem
      let alreadyRecovered = false
      for (let copy = 2; ; copy += 1) {
        if (!usedStems.has(join(finalDirectory, stem).toLocaleLowerCase('en'))) {
          if (searchMode !== 'release') break
          const existing = await existingRecoveryCopy(resolve(finalDirectory, `${stem}${derivativeExtension}`), resolve(sourceDirectory, `${stem}${sourceExtension}`), item.file.path)
          if (existing === 'absent') break
          if (existing === 'same') { alreadyRecovered = true; break }
        }
        stem = `${baseStem} (${copy})`
      }
      usedStems.add(join(finalDirectory, stem).toLocaleLowerCase('en'))
      if (alreadyRecovered) { alreadyPresent.push(item.file.path); continue }
      const finalPath = resolve(finalDirectory, `${stem}${derivativeExtension}`)
      const originalPath = resolve(sourceDirectory, `${stem}${sourceExtension}`)
      if (!inside(finalPath, canonicalRecoveryRoot) || !inside(originalPath, canonicalRecoveryRoot)) throw new Error('Unsafe recovery destination.')
      plans.push({ ...item, group, index: plans.length, sourceExtension, derivativeExtension, finalPath, originalPath, sidecarPath: `${finalPath}.tomify.json` })
    }
  }
  if (!plans.length) throw new Error('Every track in this download is already in the recovery library.')
  const destinations = plans.flatMap((plan) => [plan.finalPath, plan.originalPath, plan.sidecarPath])
  if (new Set(destinations.map((path) => path.toLocaleLowerCase('en'))).size !== destinations.length) throw new Error('The completed release contains duplicate destination track names.')
  await ensureAbsent(destinations)

  // Everything is prepared in a staging directory first (derivatives, sidecars, artwork), then listed in a manifest
  // with its sha256 before the first file is committed, so a restart part-way can finish or undo the import.
  // The agent passes its state directory; the temporary fallback is for callers that need no crash recovery.
  const stateRoot = options.stateRoot || join(tmpdir(), 'tomify-import-state')
  const importId = options.importId || randomUUID()
  const stagingRoot = await prepareImportStaging(stateRoot, importId)
  try {
    const artwork = groups.some((group) => group.requested) ? await prepareArtwork(job.request.artwork, stagingRoot) : null
    const providerType = job.indexer.type || 'newznab'
    const sourceUrl = job.result.detailsUrl || `${providerType}:${job.indexer.id}:${job.result.externalId || 'result'}`
    const acquiredAt = new Date().toISOString()
    const entries = []
    const plannedCovers = new Set()
    for (const group of artwork ? groups.filter((value) => value.requested) : []) {
      const releaseCoverPath = resolve(group.finalDirectory, 'cover.jpg')
      if (await pathExists(releaseCoverPath)) continue
      plannedCovers.add(group.finalDirectory)
      entries.push({ role: 'cover', source: artwork.coverPath, destination: releaseCoverPath, optional: true })
    }
    const importedTracks = []
    for (const plan of plans) {
      const stagedDerivative = join(stagingRoot, `${plan.index}${plan.derivativeExtension}`)
      const stagedSidecar = join(stagingRoot, `${plan.index}.tomify.json`)
      const comment = torrent
        ? `Tomify authorised torrent recovery copy; infohash=${job.torrent?.infoHash || 'unknown'}; authorisation=${job.request.authorisation.basis}`
        : `Tomify authorised Usenet recovery copy; provider=${job.indexer.name}; authorisation=${job.request.authorisation.basis}`
      const tags = ffmpegMetadataArguments({ ...plan.metadata, sourceUrl }, comment, plan.quality)
      // The chosen artwork belongs to the wanted album, so other albums in a discography keep none.
      const planArtwork = plan.group.requested ? artwork : null
      const derivativePlan = buildDerivativeArguments({ sourcePath: plan.file.path, outputPath: stagedDerivative, coverPath: planArtwork?.coverPath || null, tags })
      await run(ffmpeg, derivativePlan.args, 5 * 60_000)
      const derivativeQuality = await probe(stagedDerivative)
      const baseArtworkProvenance = buildArtworkProvenance(planArtwork, derivativePlan, resolve(plan.group.finalDirectory, 'cover.jpg'))
      const coverCreated = plannedCovers.has(plan.group.finalDirectory)
      const artworkProvenance = baseArtworkProvenance ? { ...baseArtworkProvenance, coverFileCreated: coverCreated, existingCoverKept: !coverCreated } : null
      const provenance = {
        source: torrent ? 'torrent' : 'usenet', sourceUrl, providerType, providerName: job.indexer.name, providerId: job.indexer.id, providerResultId: job.result.resultId || job.result.externalId, postedTitle: job.result.title, detailsUrl: job.result.detailsUrl,
        searchMode, postedAt: job.result.postedAt, postedSize: job.result.size, ageDaysAtDiscovery: job.result.ageDays, downloader: job.downloader,
        ...(providerType === 'newznab' ? { newznabProvider: job.indexer.name, newznabResultId: job.result.externalId, newznabTitle: job.result.title } : {}),
        ...(torrent ? { torrentInfoHash: job.torrent?.infoHash || null, torrentLinkType: job.torrent?.linkType || null, extractedFromArchive: Boolean(job.extractedPath && inside(plan.file.path, job.extractedPath)) } : {}),
        completedFileCount: completedFiles.length, acquiredAt, rightsBasis: job.request.authorisation.basis,
        confirmedBy: job.request.authorisation.confirmedBy || null, confirmedAt: job.request.authorisation.confirmedAt || null,
        archiveStatus: torrent ? 'torrent-recovery-copy' : 'usenet-recovery-copy', wantedMetadata: job.request.wantedMetadata, resolvedMetadata: plan.metadata,
        catalogueSource: job.request.catalogueSource, metadataResolution: job.request.metadataResolution, artwork: artworkProvenance,
        ...(completeness ? { completeness } : {}),
        releaseImport: { multiTrack: searchMode === 'release', acquisitionId: job.id, importedTrackNumber: plan.index + 1, importedTrackCount: plans.length, albumCount: groups.length, artist: plan.group.artist || releaseArtist || null, album: plan.group.album || null },
        sourceAudio: { path: plan.originalPath, extension: plan.sourceExtension, quality: plan.quality, preservedOriginal: true },
        derivative: { path: plan.finalPath, extension: plan.derivativeExtension, containerRemuxed: plan.sourceExtension !== plan.derivativeExtension, createdByTomify: true, operation: recoveryDerivativeOperation(plan.sourceExtension, plan.derivativeExtension, derivativePlan.embedded), audioStreamCopied: true, transcoded: false, quality: derivativeQuality },
      }
      await writeFile(stagedSidecar, JSON.stringify(provenance, null, 2), { encoding: 'utf8', flag: 'wx' })
      entries.push(
        { role: 'original', source: plan.file.path, destination: plan.originalPath },
        { role: 'derivative', source: stagedDerivative, destination: plan.finalPath },
        { role: 'sidecar', source: stagedSidecar, destination: plan.sidecarPath },
      )
      importedTracks.push({ path: plan.finalPath, originalPath: plan.originalPath, artist: plan.metadata.artist || null, albumArtist: plan.metadata.albumArtist || null, album: plan.metadata.album || null, title: plan.metadata.title, trackNumber: plan.metadata.trackNumber || null, discNumber: plan.metadata.discNumber || null, quality: plan.quality, derivative: provenance.derivative, artwork: artworkProvenance, provenance })
    }
    const first = importedTracks[0]
    const albums = groups.map((group) => ({ artist: group.artist || null, album: group.album || null, trackCount: group.items.length }))
    const result = { ...first, importedCount: importedTracks.length, importedTracks, artist: releaseArtist || null, album: releaseAlbum || null, albums, alreadyPresentCount: alreadyPresent.length, skippedExistingCount: skippedExisting.length, artwork: first.artwork, sourceFiles: [...plans.map((plan) => plan.file.path), ...alreadyPresent, ...skippedExisting], ...(completeness ? { completeness, extraFiles: completeness.extraFiles } : {}), downloadCleaned: false }
    await runManifestImport({ stateRoot, id: importId, jobId: options.importId ? job.id : null, kind: torrent ? 'torrent' : 'usenet', root: canonicalRecoveryRoot, entries, result, afterCommit: options.afterCommit })

    const cleanupEnabled = options.sabnzbdCleanup ?? process.env.TOMIFY_SABNZBD_CLEANUP === 'true'
    const cleanupRoot = options.usenetDownloadRoot ?? process.env.TOMIFY_USENET_DOWNLOAD_DIR
    const cleanup = options.cleanupCompletedDownload || cleanupCompletedDownload
    const downloadCleaned = !torrent && job.downloader === 'sabnzbd' && cleanupEnabled
      ? await cleanup(job.completedPath, cleanupRoot).catch(() => false)
      : false
    return { ...result, downloadCleaned }
  } finally {
    await removeImportStaging(stateRoot, importId)
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

// Imports audio files left behind by a single-track job, or extras excluded by a MusicBrainz tracklist,
// as an ordinary release without downloading again.
export async function importRemainingUsenetFiles(job, completedFiles, options) {
  if (job.status !== 'completed') throw new Error('Only a completed download can have its remaining files imported.')
  const tracklistExtras = Array.isArray(job.importResult?.completeness?.extraFiles) && job.importResult.completeness.extraFiles.length > 0
  if ((job.result?.searchMode || 'track') === 'release' && !tracklistExtras) throw new Error('This download was already imported as a whole release.')
  const imported = importedUsenetSourceFiles(job, completedFiles)
  const remaining = completedFiles.filter((file) => !imported.has(file.path))
  if (!remaining.length) throw new Error('Every audio file in this download has already been imported.')
  return importUsenetCompletion({ ...job, request: { ...job.request, tracklist: null }, result: { ...job.result, searchMode: 'release' } }, remaining, options)
}
