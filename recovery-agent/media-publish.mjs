// Shared, careful file publication for Tomifin: verified copies, no-clobber placement, and a safe walk of a finished
// download folder (SABnzbd's output). Used by the Family importer (family-import.mjs) and by Tomifin's Usenet
// publication (tomifin-usenet.mjs). Nothing here ever overwrites, moves or deletes a file it did not create.
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PublishError extends Error {
  constructor(code, message, { review = true, retry = false } = {}) { super(message); this.name = 'PublishError'; this.code = code; this.review = review; this.retry = retry }
}

export function within(child, parent) { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }
export function strictlyWithin(child, parent) { return child !== parent && within(child, parent) }

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// Copies source to a new file at target (which must not exist), flushes it to disk, then reads the copy back and
// checks its SHA-256 against what was read from the source. The copy is removed again if anything is off.
export async function copyVerified(source, target, { mode = 0o664 } = {}) {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  let output
  try {
    const before = await input.stat()
    if (!before.isFile()) throw new PublishError('unsafe-path', `Not a regular file: ${basename(source)}`)
    output = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let copied = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten
      copied += bytesRead
    }
    await output.sync()
    await output.close()
    output = null
    const after = await input.stat()
    if (copied !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new PublishError('unstable', `${basename(source)} changed while it was copied`, { review: false, retry: true })
    const expected = hash.digest('hex')
    // umask may have narrowed the mode; the library's group needs to read (and the importer to add to) it.
    await chmod(target, mode)
    if (await sha256File(target) !== expected) throw new PublishError('copy-mismatch', `The copy of ${basename(source)} does not match the original`)
    return { sha256: expected, size: copied }
  } catch (error) {
    if (output) await output.close().catch(() => {})
    await unlink(target).catch(() => {})
    throw error
  } finally {
    await input.close().catch(() => {})
  }
}

export async function fsyncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch(() => null)
  if (!handle) return
  try { await handle.sync() } catch { /* Not every filesystem supports fsync on a directory. */ } finally { await handle.close() }
}

// Puts a finished file at its final name without ever replacing one: link() fails with EEXIST if the name is taken.
// The file is complete before it appears, so nothing half-written is ever visible there.
export async function placeNoClobber(finished, target) {
  await link(finished, target)
  await unlink(finished)
  await fsyncDirectory(dirname(target))
}

// Hardlinks or copies source to target, which must not exist. mode is 'link', 'copy' or 'auto' (link when both are on
// one filesystem and the kernel allows it, otherwise a verified copy). Returns how it was done.
export async function materialise(source, target, mode = 'link', { fileMode = 0o664 } = {}) {
  if (mode === 'link' || mode === 'auto') {
    const [from, to] = await Promise.all([stat(source), stat(dirname(target))])
    if (from.dev === to.dev) {
      try {
        await link(source, target)
        const [made, original] = await Promise.all([lstat(target), lstat(source)])
        if (made.ino !== original.ino || made.dev !== original.dev) throw new PublishError('link-failed', `The hardlink for ${basename(target)} did not take.`, { review: false })
        return 'link'
      } catch (error) {
        if (mode === 'link' || !['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error
      }
    } else if (mode === 'link') throw new PublishError('cross-device', `${dirname(target)} is on a different filesystem, so it cannot be hardlinked.`, { review: false })
  }
  await copyVerified(source, target, { mode: fileMode })
  return 'copy'
}

// Is target already the same file as source? Same inode, or the same size and SHA-256.
export async function sameContent(target, source) {
  const [existing, original] = await Promise.all([lstat(target).catch(() => null), lstat(source)])
  if (!existing?.isFile()) return false
  if (existing.ino === original.ino && existing.dev === original.dev) return true
  return existing.size === original.size && await sha256File(target) === await sha256File(source)
}

// A folder that Jellyfin skips: hidden, with a .ignore file. Created 0775 without setgid (the library's own setgid bit
// passes the group down, and units with RestrictSUIDSGID=yes refuse a mkdir that asks for it).
export async function ensureIgnoredFolder(path) {
  await mkdir(path, { recursive: true, mode: 0o775 })
  await writeFile(join(path, '.ignore'), '', { flag: 'a' })
}

// One folder name inside parent, created if missing. Refuses a name that is a link, not a folder, or resolves anywhere
// but exactly parent/name.
export async function ensureChildFolder(parent, name, { create = true } = {}) {
  if (!safeComponent(name)) throw new PublishError('unsafe-name', `Unsafe folder name: ${JSON.stringify(String(name)).slice(0, 200)}`)
  const path = join(parent, name)
  let info = await lstat(path).catch(() => null)
  if (!info && create) {
    await mkdir(path, { mode: 0o775 }).catch((error) => { if (error?.code !== 'EEXIST') throw error })
    info = await lstat(path)
  }
  if (!info) return null
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PublishError('unsafe-path', `${path} exists and is not a plain folder.`)
  if (await realpath(path) !== path) throw new PublishError('unsafe-path', `${path} resolves somewhere else.`)
  return path
}

// A single file or folder name that is safe to create: no separators, no control characters, not hidden, not . or ..
export function safeComponent(name) {
  const value = String(name ?? '')
  return Boolean(value) && value.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith('.') && value.trim() === value
}

const ARCHIVE = /\.(?:rar|r\d{2}|zip|7z|tar|gz|tgz|bz2|xz|\d{3})$/i

export function isArchiveName(name) { return ARCHIVE.test(String(name)) }

// Walks a finished download folder without following anything: every entry must be a plain folder or regular file on
// the same filesystem as the folder itself, with a printable name. Returns the files with their sizes and inodes.
// Symlinks (which could point out of staging), devices, sockets, FIFOs and mounts inside the folder are refused.
export async function walkCompleted(root, { maxEntries = 20_000, maxBytes = Number.POSITIVE_INFINITY } = {}) {
  if (!isAbsolute(String(root))) throw new PublishError('unsafe-path', 'The download folder is not an absolute path.')
  const top = await lstat(root).catch(() => null)
  if (!top) throw new PublishError('missing', 'The finished download folder is missing.', { review: false, retry: true })
  if (top.isSymbolicLink()) throw new PublishError('unsafe-symlink', 'The finished download folder is a symbolic link.')
  if (!top.isDirectory()) throw new PublishError('unexpected-file', 'The finished download is not a folder.')
  if (await realpath(root) !== resolve(root)) throw new PublishError('unsafe-path', 'The finished download folder resolves somewhere else.')
  const files = []
  let entries = 0
  let total = 0
  async function visit(folder) {
    for (const name of (await readdir(folder)).sort()) {
      entries += 1
      if (entries > maxEntries) throw new PublishError('too-many-files', 'The finished download has too many files.')
      if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new PublishError('unsafe-name', `A file name in the download has control characters: ${JSON.stringify(name).slice(0, 120)}`)
      const path = join(folder, name)
      const info = await lstat(path)
      if (info.dev !== top.dev) throw new PublishError('nested-mount', `${relative(root, path).slice(0, 200)} is on another filesystem mounted inside the download.`)
      if (info.isSymbolicLink()) throw new PublishError('unsafe-symlink', `${relative(root, path).slice(0, 200)} is a symbolic link.`)
      if (info.isDirectory()) { await visit(path); continue }
      if (!info.isFile()) throw new PublishError('special-file', `${relative(root, path).slice(0, 200)} is not a regular file.`)
      total += info.size
      if (total > maxBytes) throw new PublishError('too-large', 'The finished download is larger than the download limit.')
      files.push({ relative: relative(root, path), path, size: info.size, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs })
    }
  }
  await visit(root)
  return { files, totalBytes: total }
}

const PRIVATE_KEEP = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg', '.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt'])
const PRIVATE_VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg'])

// A folder name for a Private download, from its title: printable, no separators, not hidden.
export function privateFolderName(title, fallback) {
  const cleaned = String(title ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 150).trim()
  return safeComponent(cleaned) ? cleaned : fallback
}

// Publishes a finished Usenet download into the Private library: its videos and subtitles, keeping their folder layout,
// copied (or hardlinked, see materialise) into <library>/.tomifin-publishing/<key>/<folder> and then renamed into
// <library>/<folder> in one step. Anything doubtful throws a PublishError for review; nothing existing is replaced.
export async function publishPrivateDownload({ key, title, root, allowedRoot, library, mode = 'auto', probe, maxBytes, stableMs = 5000, dryRun = false }) {
  const libraryPath = await realpath(library)
  const rootPath = await realpath(root)
  if (!strictlyWithin(rootPath, await realpath(allowedRoot))) throw new PublishError('unsafe-path', 'The finished download is outside the Usenet download folder.')
  const { files } = await walkCompleted(rootPath, { maxBytes })
  if (files.some((file) => isArchiveName(file.relative))) throw new PublishError('archives-remain', 'The download still holds archives: SABnzbd did not unpack it fully.')
  const wanted = files.filter((file) => PRIVATE_KEEP.has(extname(file.relative).toLowerCase()) && !/(?:^|[^a-z])sample(?:[^a-z]|$)/i.test(file.relative))
  const videos = wanted.filter((file) => PRIVATE_VIDEO.has(extname(file.relative).toLowerCase()))
  if (!videos.length) throw new PublishError('no-video', 'The download has no video file to publish.')
  if (wanted.some((file) => file.size === 0)) throw new PublishError('empty', 'The download has an empty file.')
  const lowered = new Set()
  for (const file of wanted) {
    const name = file.relative.toLowerCase()
    if (lowered.has(name)) throw new PublishError('name-collision', `Two files would get the same name: ${file.relative.slice(0, 200)}`)
    lowered.add(name)
    if (file.relative.split(sep).some((part) => !safeComponent(part))) throw new PublishError('unsafe-name', `Unsafe file name in the download: ${JSON.stringify(file.relative).slice(0, 200)}`)
  }
  await new Promise((done) => setTimeout(done, stableMs))
  for (const file of wanted) {
    const again = await lstat(file.path)
    if (again.size !== file.size || again.mtimeMs !== file.mtimeMs || again.ino !== file.ino) throw new PublishError('unstable', `${file.relative.slice(0, 200)} is still changing`, { review: false, retry: true })
  }
  for (const video of videos) {
    const probed = await probe(video.path)
    if (!probed.ok) throw new PublishError(probed.reason === 'ffprobe is not installed' ? 'no-ffprobe' : 'unreadable', `${basename(video.relative)}: ${probed.reason}`, { review: probed.reason !== 'ffprobe is not installed', retry: probed.reason === 'ffprobe is not installed' })
  }
  const folder = privateFolderName(title, key)
  const destination = join(libraryPath, folder)
  const published = wanted.map((file) => join(destination, file.relative))
  if (await lstat(destination).catch(() => null)) {
    // Already published (same files), or something else of that name that is never replaced.
    const same = await Promise.all(wanted.map((file) => sameContent(join(destination, file.relative), file.path)))
    if (same.every(Boolean)) return { result: 'already-imported', published, folder }
    throw new PublishError('conflict', `${destination} already exists with other contents; it was not changed.`)
  }
  if (dryRun) return { result: 'would-publish', published, folder }
  const publishing = join(libraryPath, '.tomifin-publishing')
  await ensureIgnoredFolder(publishing)
  const work = join(publishing, `${key}-${randomUUID()}`)
  const building = join(work, folder)
  await mkdir(building, { recursive: true, mode: 0o775 })
  const how = new Set()
  try {
    for (const file of wanted) {
      const target = join(building, file.relative)
      await mkdir(dirname(target), { recursive: true, mode: 0o775 })
      how.add(await materialise(file.path, target, mode))
    }
    await fsyncDirectory(building)
    await rename(building, destination)
    await fsyncDirectory(libraryPath)
  } catch (error) {
    await removeOwnTree(work)
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') throw new PublishError('conflict', `${destination} appeared while publishing; it was not changed.`)
    throw error
  }
  await rmdir(work).catch(() => {})
  return { result: 'published', published, folder, method: [...how].sort().join('+') }
}

// Removes a work folder this module created (files and folders only, never following links).
export async function removeOwnTree(path) {
  const info = await lstat(path).catch(() => null)
  if (!info) return
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(path).catch(() => [])) await removeOwnTree(join(path, name))
    await rmdir(path).catch(() => {})
  } else await unlink(path).catch(() => {})
}
