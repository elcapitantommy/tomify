// Supervised library moves: merging duplicates and promoting a Recovery copy over its master. Nothing is deleted.
// Every copy that leaves the library goes to <master>/_Duplicates, which holds an empty .ndignore so Navidrome and
// the inventory skip it. Each applied change is journalled under the state directory before and after it runs, a
// failure part-way puts back the moves already made, and an applied change can be undone from its journal.
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const duplicatesDirectory = '_Duplicates'
const journalIdPattern = /^[a-f0-9-]{36}$/
const reservedNames = new Set([duplicatesDirectory, '.tomify-deleted', '.tomify-source'])
const listLimit = 50

function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function writeJournal(path, journal) {
  journal.updatedAt = new Date().toISOString()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(journal, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

function moveError(error, move) {
  if (error?.code === 'EXDEV') return new Error(`${move.from} and ${move.to} are on different filesystems or mounts. Tomify only renames within one filesystem and does not copy, so this change cannot be made here.`)
  if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM') return new Error(`The recovery agent may not write to ${dirname(move.to)} or ${dirname(move.from)}. Library moves need write access to TOMIFY_MASTER_DIR (see docs/RECOVERY.md).`)
  return error instanceof Error ? error : new Error('A library move failed.')
}

export function createLibraryMoves({ masterRoot, recoveryRoot, stateRoot, renameFile = rename, now = () => new Date() }) {
  const master = masterRoot ? resolve(masterRoot) : null
  const recovery = resolve(recoveryRoot)
  const journalDirectory = join(resolve(stateRoot), 'library-moves')
  let queue = Promise.resolve()
  const serial = (task) => { const run = queue.then(task, task); queue = run.catch(() => {}); return run }

  // On the media server the recovery library is a bind mount of a folder inside the master library. A rename between
  // the two mounts fails with EXDEV, so Recovery files are moved through that folder's path under the master mount.
  async function recoveryAlias() {
    let identity
    try { const details = await stat(recovery); identity = `${details.dev}:${details.ino}` } catch { return null }
    const entries = await readdir(master, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const details = await stat(join(master, entry.name)).catch(() => null)
      if (details && `${details.dev}:${details.ino}` === identity) return join(master, entry.name)
    }
    return null
  }

  // A path the caller named: absolute, normalised, strictly inside one library, outside the folders Tomify keeps
  // for itself, not hidden, not a symbolic link, and resolving inside the same library.
  async function checkedPath(input, alias) {
    if (typeof input !== 'string' || !isAbsolute(input) || resolve(input) !== input) throw new Error('Library moves need absolute, normalised paths.')
    const library = inside(input, recovery) ? 'recovery' : inside(input, master) ? 'master' : null
    const root = library === 'recovery' ? recovery : master
    if (!library || input === root) throw new Error(`Refusing to move ${input}: it is not inside TOMIFY_MASTER_DIR or TOMIFY_RECOVERY_DIR.`)
    if (alias && inside(input, alias)) throw new Error(`Refusing to move ${input}: name Recovery files by their TOMIFY_RECOVERY_DIR path.`)
    const parts = relative(root, input).split(sep)
    if (parts.some((part) => reservedNames.has(part) || part.startsWith('.'))) throw new Error(`Refusing to move ${input}: it is in a folder Tomify keeps out of the library.`)
    let details
    try { details = await lstat(input) } catch (error) { if (error?.code === 'ENOENT') throw new Error(`${input} no longer exists. Scan the library again.`); throw error }
    if (details.isSymbolicLink() || !(details.isFile() || details.isDirectory())) throw new Error(`Refusing to move ${input}: it is not a regular file or folder.`)
    if (!inside(await realpath(input), await realpath(root))) throw new Error(`Refusing to move ${input}: it resolves outside its library.`)
    return { path: input, library, directory: details.isDirectory(), size: details.isFile() ? details.size : null }
  }

  // Where a file or folder can be renamed from: Recovery paths go through the alias inside the master mount.
  const movable = (entry, alias) => entry.library === 'recovery' && alias ? join(alias, relative(recovery, entry.path)) : entry.path
  function duplicatesPath(entry, alias) {
    const rest = entry.library === 'recovery' ? join(alias ? relative(master, alias) : basename(recovery), relative(recovery, entry.path)) : relative(master, entry.path)
    return join(master, duplicatesDirectory, rest)
  }

  // A Recovery file's sidecar and, when the file leaves the library, the preserved original its sidecar names under
  // the sibling .tomify-source folder. A promoted file's original stays in Recovery, where its sidecar still points.
  async function recoveryCompanions(entry, withOriginal) {
    const sidecar = `${entry.path}.tomify.json`
    if (entry.library !== 'recovery' || entry.directory || !(await exists(sidecar))) return []
    const companions = [{ path: sidecar, suffix: '.tomify.json' }]
    if (!withOriginal) return companions
    try {
      const source = JSON.parse(await readFile(sidecar, 'utf8'))?.sourceAudio?.path
      if (typeof source === 'string' && dirname(source) === join(dirname(entry.path), '.tomify-source') && (await lstat(source)).isFile()) companions.push({ path: source, original: true })
    } catch { /* an unreadable sidecar or a missing original stays where it is */ }
    return companions
  }

  // The moves for one file or folder, its companions travelling with it.
  async function movesFor(entry, to, alias, withOriginal = true) {
    const moves = [{ from: movable(entry, alias), to, path: entry.path }]
    for (const companion of await recoveryCompanions(entry, withOriginal)) {
      const from = movable({ ...entry, path: companion.path }, alias)
      moves.push({ from, to: companion.original ? join(dirname(to), '.tomify-source', basename(companion.path)) : `${to}${companion.suffix}`, path: companion.path })
    }
    return moves
  }

  async function plan(body = {}) {
    if (!master) throw new Error('TOMIFY_MASTER_DIR is not configured on the recovery agent.')
    const alias = await recoveryAlias()
    const kind = body.kind
    let moves
    let entries
    if (kind === 'merge') {
      const paths = [...new Set(Array.isArray(body.paths) ? body.paths : [])]
      if (paths.length < 2 || paths.length > 50 || !paths.includes(body.keep)) throw new Error('Choose the copy to keep from at least two copies.')
      entries = []
      for (const path of paths) entries.push(await checkedPath(path, alias))
      for (const left of entries) for (const right of entries) if (left !== right && inside(right.path, left.path)) throw new Error(`${right.path} is inside ${left.path}; merge folders or files, not both.`)
      moves = []
      for (const entry of entries) if (entry.path !== body.keep) moves.push(...await movesFor(entry, duplicatesPath(entry, alias), alias))
    } else if (kind === 'promote') {
      const masterEntry = await checkedPath(body.master, alias)
      const recoveryEntry = await checkedPath(body.recovery, alias)
      if (masterEntry.library !== 'master' || recoveryEntry.library !== 'recovery' || masterEntry.directory || recoveryEntry.directory) throw new Error('Promotion replaces one master file with one Recovery file.')
      entries = [masterEntry, recoveryEntry]
      const target = join(dirname(masterEntry.path), basename(masterEntry.path, extname(masterEntry.path)) + extname(recoveryEntry.path))
      moves = [...await movesFor(masterEntry, duplicatesPath(masterEntry, alias), alias), ...await movesFor(recoveryEntry, target, alias, false)]
    } else {
      throw new Error('Unknown library move.')
    }
    // A destination counts as taken unless an earlier move in this plan empties it.
    const vacated = new Set()
    const conflicts = []
    for (const move of moves) {
      if (!vacated.has(move.to) && await exists(move.to)) conflicts.push(move.to)
      vacated.add(move.from)
    }
    return { kind, label: String(body.label || '').slice(0, 300), moves, conflicts, sizes: Object.fromEntries(entries.filter((entry) => entry.size !== null).map((entry) => [entry.path, entry.size])) }
  }

  const journalPath = (id) => {
    if (!journalIdPattern.test(String(id || ''))) throw new Error('Invalid library move id.')
    return join(journalDirectory, `${id}.json`)
  }

  // Renames in order; on a failure, the moves already made are put back newest first.
  async function runMoves(moves) {
    const done = []
    try {
      for (const move of moves) {
        if (await exists(move.to)) throw new Error(`${move.to} already exists; Tomify moved nothing over it.`)
        await mkdir(dirname(move.to), { recursive: true })
        try { await renameFile(move.from, move.to) } catch (error) { throw moveError(error, move) }
        done.push(move)
      }
    } catch (error) {
      const stuck = []
      for (const move of done.reverse()) await renameFile(move.to, move.from).catch(() => stuck.push(move.to))
      error.stuck = stuck
      throw error
    }
  }

  async function apply(body = {}) {
    return serial(async () => {
      const planned = await plan(body)
      if (planned.conflicts.length) throw new Error(`Refusing to move over existing files: ${planned.conflicts.join(', ')}`)
      if (!planned.moves.length) throw new Error('Nothing to move.')
      const id = randomUUID()
      const path = journalPath(id)
      const journal = { version: 1, id, createdAt: now().toISOString(), kind: planned.kind, label: planned.label, moves: planned.moves, status: 'applying', error: null }
      await writeJournal(path, journal)
      try {
        const duplicates = join(master, duplicatesDirectory)
        await mkdir(duplicates, { recursive: true })
        await writeFile(join(duplicates, '.ndignore'), '', { flag: 'a' })
        await runMoves(planned.moves)
      } catch (error) {
        journal.status = 'rolled-back'
        journal.error = error.message + (error.stuck?.length ? ` These could not be put back: ${error.stuck.join(', ')}` : '')
        await writeJournal(path, journal)
        throw new Error(journal.error)
      }
      journal.status = 'applied'
      await writeJournal(path, journal)
      return { journal }
    })
  }

  async function undo(body = {}) {
    return serial(async () => {
      const path = journalPath(body.id)
      const journal = JSON.parse(await readFile(path, 'utf8'))
      if (journal.status !== 'applied') throw new Error('Only an applied library move can be undone.')
      const reverse = [...journal.moves].reverse().map((move) => ({ from: move.to, to: move.from, path: move.path }))
      // As when planning, a path an earlier reverse move empties is free, and one it fills is present.
      const vacated = new Set()
      const filled = new Set()
      for (const move of reverse) {
        if (![move.from, move.to].every((item) => inside(item, master) || inside(item, recovery))) throw new Error('This journal names a path outside the libraries.')
        if (!filled.has(move.from) && !(await exists(move.from))) throw new Error(`${move.from} is gone, so this change cannot be undone.`)
        if (!vacated.has(move.to) && await exists(move.to)) throw new Error(`${move.to} is in use again, so this change cannot be undone.`)
        vacated.add(move.from)
        filled.add(move.to)
      }
      try { await runMoves(reverse) } catch (error) {
        throw new Error(error.message + (error.stuck?.length ? ` These could not be put back: ${error.stuck.join(', ')}` : ''))
      }
      journal.status = 'undone'
      journal.undoneAt = now().toISOString()
      await writeJournal(path, journal)
      return { journal }
    })
  }

  async function list() {
    const names = await readdir(journalDirectory).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
    const journals = []
    for (const name of names.filter((item) => journalIdPattern.test(basename(item, '.json')) && item.endsWith('.json'))) {
      try { journals.push(JSON.parse(await readFile(join(journalDirectory, name), 'utf8'))) } catch { /* skip a journal being written */ }
    }
    journals.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return { moves: journals.slice(0, listLimit) }
  }

  return { plan, apply, undo, list }
}
