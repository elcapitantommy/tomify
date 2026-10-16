import { lstat, mkdir, stat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { classifyQuality, qualityTiers } from '../shared/quality.mjs'
import { reportLibraryInventory } from './inventory-report.mjs'

const audioExtensions = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.mka', '.wma', '.webm'])
const inventoryFileName = 'library-inventory.json'

function text(value) { return String(value ?? '').trim() }
function positiveNumber(value) {
  const match = text(value).match(/^\s*(\d{1,4})(?:\s*\/\s*\d+)?/)
  const number = match ? Number(match[1]) : null
  return Number.isInteger(number) && number > 0 ? number : null
}
function normalizedTags(tags) {
  const result = {}
  for (const [key, value] of Object.entries(tags || {})) {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (name && text(value) && result[name] === undefined) result[name] = text(value)
  }
  return result
}
function first(tags, ...keys) { return keys.map((key) => tags[key]).find(Boolean) || null }

export function inventoryStatePath(stateRoot) {
  return join(resolve(stateRoot), inventoryFileName)
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return null; return null }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

// The identity of a directory, so a bind mount of it is recognised under another path.
async function directoryIdentity(path) {
  if (!path) return null
  try { const details = await stat(resolve(path)); return details.isDirectory() ? `${details.dev}:${details.ino}` : null } catch { return null }
}

// Hidden directories are skipped. `.tomify-source` is the exception: its direct audio children are recorded as
// unprobed sourceFiles so health checks can find broken provenance, but they are not counted as library tracks.
// `skip` holds directory identities to leave out, such as the recovery bind mount inside the master library.
async function walkLibrary(root, library, progress, skip = new Set()) {
  if (!root) return { files: [], sidecars: [], sourceFiles: [] }
  const absoluteRoot = resolve(root)
  let rootDetails
  try { rootDetails = await lstat(absoluteRoot) } catch (error) { if (error?.code === 'ENOENT') return { files: [], sidecars: [], sourceFiles: [] }; throw error }
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) return { files: [], sidecars: [], sourceFiles: [] }
  const directories = [absoluteRoot]
  const files = []
  const sidecars = []
  const sourceFiles = []
  while (directories.length) {
    const directory = directories.pop()
    try {
      const details = await lstat(directory)
      if (!details.isDirectory() || details.isSymbolicLink()) continue
      if (skip.has(`${details.dev}:${details.ino}`)) continue
    } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    progress({ currentLibrary: library, currentPath: directory })
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'variant' }))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.tomify-source') {
          const sourceEntries = await readdir(path, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
          for (const source of sourceEntries) {
            if (!source.isFile() || source.isSymbolicLink() || !audioExtensions.has(extname(source.name).toLowerCase())) continue
            const sourcePath = join(path, source.name)
            const details = await lstat(sourcePath).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
            if (details?.isFile() && !details.isSymbolicLink()) sourceFiles.push({ library, path: sourcePath, size: details.size, mtime: details.mtime.toISOString(), mtimeMs: details.mtimeMs })
          }
        } else if (!entry.name.startsWith('.')) directories.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (audioExtensions.has(extname(entry.name).toLowerCase())) {
        const details = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
        if (!details) continue
        if (details.isFile() && !details.isSymbolicLink()) files.push({ library, path, size: details.size, mtime: details.mtime.toISOString(), mtimeMs: details.mtimeMs })
      } else if (entry.name.endsWith('.tomify.json')) {
        const details = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
        if (!details) continue
        if (details.isFile() && !details.isSymbolicLink()) sidecars.push({ library, path, size: details.size, mtime: details.mtime.toISOString(), mtimeMs: details.mtimeMs })
      }
    }
  }
  return { files, sidecars, sourceFiles }
}

async function inspectSidecar(entry, audioPaths) {
  const audioPath = entry.path.slice(0, -'.tomify.json'.length)
  try {
    const value = JSON.parse(await readFile(entry.path, 'utf8'))
    return {
      ...entry, audioPath, orphan: !audioPaths.has(audioPath), backend: text(value?.source || value?.backend) || 'unknown',
      sourcePath: text(value?.sourceAudio?.path) || null,
    }
  } catch (error) {
    return { ...entry, audioPath, orphan: !audioPaths.has(audioPath), backend: 'unknown', sourcePath: null, error: error instanceof Error ? error.message : 'Unreadable sidecar.' }
  }
}

function probeRecord(entry, quality, sidecar) {
  const tags = normalizedTags(quality?.tags)
  const classified = classifyQuality(quality)
  return {
    ...entry,
    probe: {
      codec: quality?.codec || null, bitrate: Number(quality?.bitrate) || null, sampleRate: Number(quality?.sampleRate) || null,
      duration: Number(quality?.duration) || null, tier: classified.tier,
    },
    tags: {
      artist: first(tags, 'artist'), albumArtist: first(tags, 'albumartist', 'albumartists'), album: first(tags, 'album'), title: first(tags, 'title'),
      trackNumber: positiveNumber(first(tags, 'tracknumber', 'track')), discNumber: positiveNumber(first(tags, 'discnumber', 'disc')),
      recordingId: first(tags, 'musicbrainztrackid', 'musicbrainzrecordingid'), releaseId: first(tags, 'musicbrainzalbumid'),
      releaseGroupId: first(tags, 'musicbrainzreleasegroupid'), artistId: first(tags, 'musicbrainzartistid'), albumArtistId: first(tags, 'musicbrainzalbumartistid'),
    },
    sidecar: sidecar ? { path: sidecar.path, backend: sidecar.backend, sourcePath: sidecar.sourcePath } : null,
  }
}

/** Walk both libraries and atomically replace their inventory. Only the state directory is ever written. */
export async function scanLibraryInventory({ masterRoot = null, recoveryRoot, stateRoot, probe, now = () => new Date().toISOString(), onProgress = () => {} }) {
  if (typeof probe !== 'function') throw new Error('Inventory requires an audio probe.')
  const statePath = inventoryStatePath(stateRoot)
  const previous = await readJson(statePath)
  const previousFiles = new Map((Array.isArray(previous?.files) ? previous.files : []).map((file) => [`${file.library}\0${file.path}`, file]))
  const progress = { state: 'running', progress: 0, filesDiscovered: 0, filesProcessed: 0, filesProbed: 0, filesReused: 0, currentLibrary: null, currentPath: null }
  const update = (change = {}) => { Object.assign(progress, change); onProgress({ ...progress }) }
  const collected = []
  const recoveryIdentity = await directoryIdentity(recoveryRoot)
  collected.push(await walkLibrary(masterRoot, 'master', update, new Set(recoveryIdentity ? [recoveryIdentity] : [])))
  collected.push(await walkLibrary(recoveryRoot, 'recovery', update))
  const discoveredFiles = collected.flatMap((value) => value.files).sort((left, right) => left.library.localeCompare(right.library) || left.path.localeCompare(right.path, 'en', { sensitivity: 'variant' }))
  const discoveredSidecars = collected.flatMap((value) => value.sidecars).sort((left, right) => left.path.localeCompare(right.path, 'en', { sensitivity: 'variant' }))
  const sourceFiles = collected.flatMap((value) => value.sourceFiles).sort((left, right) => left.path.localeCompare(right.path, 'en', { sensitivity: 'variant' }))
  update({ filesDiscovered: discoveredFiles.length, currentLibrary: null, currentPath: null })
  const audioPaths = new Set(discoveredFiles.map((file) => file.path))
  const sidecars = []
  for (const entry of discoveredSidecars) sidecars.push(await inspectSidecar(entry, audioPaths))
  const sidecarsByAudio = new Map(sidecars.filter((sidecar) => !sidecar.orphan).map((sidecar) => [sidecar.audioPath, sidecar]))
  const files = []
  for (const entry of discoveredFiles) {
    update({ currentLibrary: entry.library, currentPath: entry.path })
    const earlier = previousFiles.get(`${entry.library}\0${entry.path}`)
    const sidecar = sidecarsByAudio.get(entry.path) || null
    if (earlier && earlier.size === entry.size && earlier.mtimeMs === entry.mtimeMs && earlier.probe && earlier.tags) {
      files.push({ ...earlier, ...entry, sidecar: sidecar ? { path: sidecar.path, backend: sidecar.backend, sourcePath: sidecar.sourcePath } : null })
      const filesProcessed = progress.filesProcessed + 1
      update({ filesProcessed, filesReused: progress.filesReused + 1, progress: discoveredFiles.length ? Math.round(filesProcessed / discoveredFiles.length * 100) : 100 })
      continue
    }
    try {
      files.push(probeRecord(entry, await probe(entry.path), sidecar))
    } catch (error) {
      files.push({ ...probeRecord(entry, null, sidecar), probeError: error instanceof Error ? error.message : 'Audio probe failed.' })
    }
    const filesProcessed = progress.filesProcessed + 1
    update({ filesProcessed, filesProbed: progress.filesProbed + 1, progress: discoveredFiles.length ? Math.round(filesProcessed / discoveredFiles.length * 100) : 100 })
  }
  const completedAt = now()
  const inventory = { version: 2, completedAt, roots: { master: masterRoot ? resolve(masterRoot) : null, recovery: recoveryRoot ? resolve(recoveryRoot) : null }, files, sidecars, sourceFiles }
  await writeJsonAtomic(statePath, inventory)
  update({ state: 'completed', progress: 100, completedAt, currentLibrary: null, currentPath: null })
  return inventory
}

export function summarizeLibraryInventory(inventory) {
  const files = Array.isArray(inventory?.files) ? inventory.files : []
  const sidecars = Array.isArray(inventory?.sidecars) ? inventory.sidecars : []
  const byLibrary = { master: 0, recovery: 0 }
  const byQualityTier = Object.fromEntries(qualityTiers().map((tier) => [tier, 0]))
  const bySource = {}
  for (const file of files) {
    byLibrary[file.library] = (byLibrary[file.library] || 0) + 1
    const tier = qualityTiers().includes(file.probe?.tier) ? file.probe.tier : 'unknown'
    byQualityTier[tier] += 1
    const source = text(file.sidecar?.backend) || 'unknown'
    bySource[source] = (bySource[source] || 0) + 1
  }
  return {
    completedAt: inventory?.completedAt || null, byLibrary, byQualityTier, bySource,
    totals: { files: files.length, bytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0), sidecars: sidecars.length, orphanSidecars: sidecars.filter((sidecar) => sidecar.orphan).length },
  }
}

/** One background inventory scan at a time, with in-memory progress and the last atomic result on disk. */
export function createInventoryController(options) {
  let running = null
  let loadPromise = null
  let lastInventory = null
  let status = { state: 'idle', progress: 0, startedAt: null, completedAt: null, lastCompletedAt: null, filesDiscovered: 0, filesProcessed: 0, filesProbed: 0, filesReused: 0, currentLibrary: null, currentPath: null, error: null }
  const load = async () => {
    if (!loadPromise) loadPromise = readJson(inventoryStatePath(options.stateRoot)).then((value) => { lastInventory = value; status.lastCompletedAt = value?.completedAt || null })
    await loadPromise
  }
  return {
    async start() {
      await load()
      if (running) return { started: false, status: { ...status } }
      const startedAt = (options.now || (() => new Date().toISOString()))()
      status = { ...status, state: 'running', progress: 0, startedAt, completedAt: null, filesDiscovered: 0, filesProcessed: 0, filesProbed: 0, filesReused: 0, currentLibrary: null, currentPath: null, error: null }
      running = scanLibraryInventory({ ...options, onProgress: (progress) => { status = { ...status, ...progress } } })
        .then((inventory) => { lastInventory = inventory; status = { ...status, state: 'completed', progress: 100, completedAt: inventory.completedAt, lastCompletedAt: inventory.completedAt, currentLibrary: null, currentPath: null }; return inventory })
        .catch((error) => { status = { ...status, state: 'failed', error: error instanceof Error ? error.message : 'Inventory scan failed.', currentLibrary: null, currentPath: null }; throw error })
        .finally(() => { running = null })
      running.catch((error) => options.log?.(`Library inventory scan failed: ${error instanceof Error ? error.message : 'unknown error'}`))
      return { started: true, status: { ...status } }
    },
    async status() { await load(); return { ...status } },
    async summary() { await load(); return summarizeLibraryInventory(lastInventory) },
    async report(options = {}) { await load(); return reportLibraryInventory(lastInventory, options) },
    async settled() { await running; return lastInventory },
  }
}
