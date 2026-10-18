// Crash-safe imports. Before an import commits its first file it writes a manifest in the agent's state directory
// listing every planned destination with its source and sha256, and marks each file as it commits. If the agent
// stops part-way, the job runner reads the manifest on start-up and either commits the rest or, when the sources
// are gone, removes every file this import added. A destination whose contents no longer match the manifest is
// never deleted or overwritten.
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { commitFile, importTemporaryPath } from './commit.mjs'
import { defaultLoudnessTagger } from './loudness.mjs'
import { defaultStyleTagger } from './track-style.mjs'

const importIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }

export function importStatePaths(stateRoot, id) {
  if (!importIdPattern.test(String(id || ''))) throw new Error('Invalid import id.')
  const root = resolve(stateRoot)
  return { manifestDirectory: join(root, 'import-manifests'), manifestPath: join(root, 'import-manifests', `${id}.json`), stagingRoot: join(root, 'import-staging', id) }
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// The sha256 of a regular file, or null when nothing (or something other than a file) is there.
async function fileHash(path) {
  try {
    if (!(await lstat(path)).isFile()) return 'not-a-file'
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return sha256File(path)
}

async function writeManifest(handle) {
  handle.data.updatedAt = new Date().toISOString()
  await mkdir(dirname(handle.path), { recursive: true })
  const temporary = `${handle.path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(handle.data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, handle.path)
}

// A fresh, empty staging directory for an import's derivatives and sidecars. It lives under the state directory
// rather than /tmp, which the agent's unit makes private and empties on every restart.
export async function prepareImportStaging(stateRoot, id) {
  const { stagingRoot } = importStatePaths(stateRoot, id)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  return stagingRoot
}

export async function removeImportStaging(stateRoot, id) {
  await rm(importStatePaths(stateRoot, id).stagingRoot, { recursive: true, force: true })
}

// Forgets a finished import: its manifest and anything still staged.
export async function discardImport(stateRoot, id) {
  const { manifestPath, stagingRoot } = importStatePaths(stateRoot, id)
  await rm(manifestPath, { force: true })
  await rm(stagingRoot, { recursive: true, force: true })
}

export async function createImportManifest({ path, id, jobId = null, kind, root, entries, result }) {
  const planned = []
  for (const entry of entries) {
    planned.push({ role: entry.role, source: entry.source, destination: entry.destination, sha256: await sha256File(entry.source), optional: Boolean(entry.optional), status: 'pending' })
  }
  const handle = { path, data: { version: 1, id, jobId, kind, root, state: 'committing', createdAt: new Date().toISOString(), updatedAt: null, entries: planned, result, error: null } }
  await writeManifest(handle)
  return handle
}

export async function loadImportManifest(path) {
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('Unreadable import manifest.')
  return { path, data }
}

class DestinationConflict extends Error {
  constructor(destination) {
    super(`A different file already exists at ${destination}; Tomify left it in place.`)
    this.destination = destination
  }
}

// Commits one manifest entry. A destination already holding the expected sha256 counts as committed; an optional
// entry (a release cover) whose destination holds anything else keeps that file.
async function commitEntry(handle, entry) {
  await mkdir(dirname(entry.destination), { recursive: true })
  try {
    await commitFile(entry.source, entry.destination, { temporaryId: handle.data.id })
    entry.status = 'committed'
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await fileHash(entry.destination)
    if (existing === entry.sha256) entry.status = 'committed'
    else if (entry.optional) entry.status = 'kept-existing'
    else throw new DestinationConflict(entry.destination)
  }
  await writeManifest(handle)
}

export async function commitImportManifest(handle, { afterCommit = null } = {}) {
  for (const [index, entry] of handle.data.entries.entries()) {
    if (entry.status !== 'pending') continue
    await commitEntry(handle, entry)
    if (afterCommit) await afterCommit(entry, index)
  }
  handle.data.state = 'committed'
  await writeManifest(handle)
}

// Removes every file this import committed, newest first. A destination is only deleted while it still holds the
// sha256 the manifest recorded; anything else there is left in place and reported. An entry still marked pending
// whose destination holds the expected file was committed just before a crash, so it is removed too: every
// destination was checked to be absent before the manifest was written.
export async function rollbackImportManifest(handle, error = null) {
  const removed = []
  const conflicts = []
  for (const entry of [...handle.data.entries].reverse()) {
    await unlink(importTemporaryPath(entry.destination, handle.data.id)).catch(() => {})
    if (entry.status === 'kept-existing' || entry.status === 'rolled-back') continue
    const existing = await fileHash(entry.destination)
    if (existing === null) { entry.status = 'rolled-back'; continue }
    if (existing === entry.sha256) {
      await unlink(entry.destination)
      removed.push(entry.destination)
      entry.status = 'rolled-back'
    } else if (entry.status === 'committed') {
      conflicts.push(entry.destination)
    }
  }
  handle.data.state = 'rolled-back'
  handle.data.error = error
  handle.data.conflicts = conflicts
  await writeManifest(handle)
  return { removed, conflicts }
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}` }

// Finishes an import interrupted by a crash or restart. Destinations already holding the expected sha256 count as
// committed and the rest are committed from their sources. When a source is gone (or changed), or a destination
// holds a different file, the import is rolled back instead. Returns the job outcome.
export async function resumeImportManifest(handle, { allowedRoot }) {
  const { data } = handle
  if (data.state === 'committed') return { status: 'completed', result: data.result, conflicts: [] }
  if (data.state === 'rolled-back') return { status: 'failed', error: data.error || 'The import was interrupted and rolled back.', conflicts: data.conflicts || [] }
  const root = await realpath(resolve(allowedRoot)).catch(() => resolve(allowedRoot))
  if (!data.entries.every((entry) => inside(resolve(entry.destination), root))) throw new Error('An import manifest names a destination outside the recovery library.')

  const conflicts = []
  const missingSources = []
  for (const entry of data.entries) {
    if (entry.status === 'kept-existing') continue
    const existing = await fileHash(entry.destination)
    if (existing === entry.sha256) { entry.status = 'committed'; continue }
    if (existing !== null) {
      if (entry.optional) { entry.status = 'kept-existing'; continue }
      conflicts.push(entry.destination)
      continue
    }
    if (await fileHash(entry.source) !== entry.sha256) missingSources.push(entry.source)
  }
  await writeManifest(handle)

  if (conflicts.length || missingSources.length) {
    const reason = conflicts.length
      ? `${plural(conflicts.length, 'file')} in the recovery library changed while the import was interrupted, so Tomify left ${conflicts.length === 1 ? 'it' : 'them'} in place and removed the rest of this import: ${conflicts.join(', ')}`
      : `The import was interrupted and ${plural(missingSources.length, 'source file')} it still needed ${missingSources.length === 1 ? 'is' : 'are'} gone, so Tomify removed the files it had already added. Download it again to retry.`
    const rollback = await rollbackImportManifest(handle, reason)
    const left = rollback.conflicts.filter((path) => !conflicts.includes(path))
    const error = left.length ? `${reason} Changed files left in place: ${left.join(', ')}` : reason
    handle.data.error = error
    await writeManifest(handle)
    return { status: 'failed', error, conflicts: [...conflicts, ...left], removed: rollback.removed }
  }

  await commitImportManifest(handle)
  return { status: 'completed', result: data.result, conflicts: [] }
}

// Writes the manifest, commits every entry, and rolls back on any failure. A job's import keeps its manifest after
// committing so the runner can still finish the job if the agent stops before the job is saved; the runner discards
// it once the job is completed or failed. An import with no job behind it discards its own manifest when it ends.
// Staged derivatives get their BPM, genre and mood tags (track-style.mjs) and then their ReplayGain tags
// (loudness.mjs) first, so the manifest records the tagged files. Style tagging rewrites each file with ffmpeg, so it
// runs before rsgain rather than after it.
export async function runManifestImport({ stateRoot, id, jobId = null, kind, root, entries, result, afterCommit = null, tagStyle = defaultStyleTagger(), tagLoudness = defaultLoudnessTagger() }) {
  const { manifestPath, stagingRoot } = importStatePaths(stateRoot, id)
  await tagStyle(entries, stagingRoot)
  await tagLoudness(entries, stagingRoot)
  const handle = await createImportManifest({ path: manifestPath, id, jobId, kind, root, entries, result })
  try {
    await commitImportManifest(handle, { afterCommit })
  } catch (error) {
    await rollbackImportManifest(handle, error instanceof Error ? error.message : 'The import failed.')
    if (!jobId) await discardImport(stateRoot, id)
    throw error
  }
  if (!jobId) await discardImport(stateRoot, id)
  return result
}

// What the job runner uses to find and settle interrupted imports.
export function createImportRecovery({ stateRoot, recoveryRoot }) {
  return {
    async manifestIds() {
      const { manifestDirectory } = importStatePaths(stateRoot, 'probe')
      const names = await readdir(manifestDirectory).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
      return names.filter((name) => name.endsWith('.json')).map((name) => basename(name, '.json')).filter((id) => importIdPattern.test(id))
    },
    async resume(id) {
      return resumeImportManifest(await loadImportManifest(importStatePaths(stateRoot, id).manifestPath), { allowedRoot: recoveryRoot })
    },
    // An import whose job is gone (cancelled, or a synchronous request that never got its answer) is rolled back.
    async rollback(id) {
      const handle = await loadImportManifest(importStatePaths(stateRoot, id).manifestPath)
      if (handle.data.state === 'committing') return rollbackImportManifest(handle, 'The import was interrupted and its job no longer exists.')
      return { removed: [], conflicts: handle.data.conflicts || [] }
    },
    discard: (id) => discardImport(stateRoot, id),
  }
}
