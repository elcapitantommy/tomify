// Finishing a Tomifin torrent whose data qBittorrent left in its staging folder.
//
// Tomifin asks qBittorrent to keep an unfinished torrent in <library>/.tomifin-incomplete/<job id> and to move it to
// the library when it completes. When qBittorrent does not make that move (it failed, or the torrent finished in a
// way that did not trigger it), the torrent sits complete and seeding in staging. This module checks such a torrent
// very carefully and publishes its content into the library itself:
//
//   1. readyForFinalisation: qBittorrent reports it 100 % complete, in a finished (seeding, queued for seeding,
//      stopped after finishing or rechecking a finished torrent) state.
//   2. stagedContent: it is in the job's own category, carries the job's tag, and qBittorrent's content path is
//      strictly inside that job's own staging folder (no "..", no other folder).
//   3. inspectStaged: on disk, the staging folder and the content are plain folders and files (no symlinks, special
//      files or mounts anywhere, see walkCompleted), resolve exactly where expected, are writable by the agent and on
//      the library's filesystem, and the library has nothing of that name yet.
//   4. publishStagedItem: the top-level folder (or file) is put into the library in one step, never replacing
//      anything: a folder by reserving its name with mkdir (which fails if the name is taken) and renaming the
//      download onto that empty reservation; a single file by hardlink (which fails if the name is taken).
//
// Nothing here deletes a file. The only removals are rmdir of empty folders (which the kernel refuses for a folder
// that holds anything) and the unlink of the staging name of a single file once its hardlink in the library exists.
import { constants as fsConstants } from 'node:fs'
import { access, link, lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { PublishError, fsyncDirectory, safeComponent, walkCompleted } from './media-publish.mjs'

export const STAGING_FOLDER = '.tomifin-incomplete'
// qBittorrent states of a torrent that has every wanted piece: seeding (also forced, queued or stalled), stopped or
// paused after finishing (5.x and 4.x names), and rechecking a finished torrent.
export const FINISHED_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP', 'checkingUP'])
const PARTIAL = /\.!qB$/

export class FinaliseError extends Error {
  // retry: the problem may pass by itself (a missing mount, a file still changing), so it is tried again with backoff.
  constructor(code, message, { retry = false } = {}) { super(message); this.name = 'FinaliseError'; this.code = code; this.retry = retry }
}

function text(value) { return String(value ?? '').trim() }
function within(child, parent) { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }
function strictlyWithin(child, parent) { return child !== parent && within(child, parent) }
function trimSlashes(path) { return path.replace(/(.)\/+$/, '$1') }
function tags(torrent) { return text(torrent?.tags).split(',').map(text) }

// Where qBittorrent keeps one job's unfinished data, in qBittorrent's view of the filesystem.
export function stagingPath(destination, id) {
  return `${(destination.saveQbittorrentPath || destination.qbittorrentPath).replace(/\/+$/, '')}/${STAGING_FOLDER}/${id}`
}

// Whether qBittorrent reports the torrent as completely downloaded and finished.
export function readyForFinalisation(torrent) {
  if (!torrent || !FINISHED_STATES.has(text(torrent.state))) return false
  if (Number(torrent.progress) !== 1) return false
  // Newer qBittorrent also reports what is left to download; when it does, it must be nothing.
  if (torrent.amount_left !== undefined && torrent.amount_left !== null && Number(torrent.amount_left) !== 0) return false
  return true
}

// Checks qBittorrent's own report of a finished torrent against the job: category, tag and content path. Returns
// null when the content is not in staging at all (qBittorrent moved it, see finishedInLibrary in tomifin.mjs), or
// the content's path relative to the staging folder and its top-level entry. Throws FinaliseError for anything that
// does not belong to this job.
export function stagedContent(torrent, destination, id) {
  if (text(torrent?.category) !== destination.category) throw new FinaliseError('wrong-category', `The torrent is not in qBittorrent category ${destination.category}.`)
  if (!tags(torrent).includes(`tomifin-${id}`)) throw new FinaliseError('wrong-tag', 'The torrent does not carry this download\'s tag.')
  const raw = String(torrent?.content_path ?? '')
  if (!raw || !isAbsolute(raw) || /[\u0000-\u001f\u007f\\]/.test(raw)) throw new FinaliseError('unsafe-path', 'qBittorrent reports no usable content path for the torrent.')
  // ".." or "." segments are refused outright rather than resolved, so nothing can step out of the folder.
  if (raw.split('/').some((part) => part === '..' || part === '.')) throw new FinaliseError('unsafe-path', 'qBittorrent\'s content path for the torrent steps out of its folder.')
  const staging = normalize(stagingPath(destination, id))
  const content = trimSlashes(normalize(raw))
  if (!strictlyWithin(content, staging)) {
    if (within(content, normalize(destination.qbittorrentPath)) && !within(content, normalize(join(destination.saveQbittorrentPath || destination.qbittorrentPath, STAGING_FOLDER)))) return null
    throw new FinaliseError('foreign-path', 'qBittorrent keeps the torrent outside this download\'s own staging folder.')
  }
  const downloadPath = text(torrent.download_path)
  if (downloadPath && trimSlashes(normalize(downloadPath)) !== staging) throw new FinaliseError('foreign-path', 'qBittorrent\'s download folder for the torrent is not this download\'s own staging folder.')
  const savePath = text(torrent.save_path)
  if (savePath && trimSlashes(normalize(savePath)) !== trimSlashes(normalize(destination.saveQbittorrentPath || destination.qbittorrentPath))) throw new FinaliseError('foreign-path', 'qBittorrent\'s save folder for the torrent is not the library.')
  const rel = content.slice(staging.length + 1)
  const top = rel.split('/')[0]
  if (!safeComponent(top)) throw new FinaliseError('unsafe-name', 'The download\'s top-level name cannot be used in the library (it is hidden, too long or has unusual characters).')
  return { relative: rel, top }
}

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

// The library folder (resolved) and the job's staging folder on the agent's side. The staging folder must resolve to
// exactly that place: a symlink anywhere on the way is refused. staging is null when the folder does not exist.
export async function hostStaging(destination, id) {
  const library = await realpath(destination.hostPath).catch((error) => { throw missing(error) ? new FinaliseError('library-missing', `The ${destination.label} library folder is not there (is it mounted?).`, { retry: true }) : error })
  const subfolder = relative(destination.qbittorrentPath, destination.saveQbittorrentPath || destination.qbittorrentPath)
  if (subfolder.startsWith('..') || isAbsolute(subfolder)) throw new FinaliseError('unsafe-path', 'The download folder is outside the library.')
  const staging = join(library, subfolder, STAGING_FOLDER, id)
  const info = await lstat(staging).catch((error) => { if (missing(error)) return null; throw error })
  if (!info) return { library, staging: null, expected: staging }
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(staging) !== staging) throw new FinaliseError('unsafe-symlink', 'The download\'s staging folder is a link or resolves somewhere else.')
  return { library, staging, expected: staging }
}

async function writable(path) {
  try { await access(path, fsConstants.W_OK | fsConstants.X_OK); return true } catch { return false }
}

// Checks one staged top-level entry (a folder or a single file) is safe to publish. Returns its kind.
async function checkItem(location, staged) {
  const item = join(location.staging, staged.top)
  const info = await lstat(item).catch((error) => { if (missing(error)) return null; throw error })
  if (!info) throw new FinaliseError('missing', 'The downloaded files are not in the staging folder.', { retry: true })
  if (info.isSymbolicLink()) throw new FinaliseError('unsafe-symlink', 'The download is a symbolic link.')
  const content = join(location.staging, staged.relative)
  const contentInfo = await lstat(content).catch((error) => { if (missing(error)) return null; throw error })
  if (!contentInfo) throw new FinaliseError('missing', 'The file or folder qBittorrent reports for the download is not there.', { retry: true })
  if (contentInfo.isSymbolicLink() || await realpath(content) !== content) throw new FinaliseError('unsafe-symlink', 'The download\'s content is a link or resolves somewhere else.')
  let kind
  if (info.isDirectory()) {
    let files
    try { ({ files } = await walkCompleted(item)) }
    catch (error) { if (error instanceof PublishError) throw new FinaliseError(error.code, error.message, { retry: error.retry }); throw error }
    if (!files.length) throw new FinaliseError('empty', 'The download folder has no files.')
    if (files.some((file) => PARTIAL.test(file.relative))) throw new FinaliseError('incomplete', 'The download still has unfinished (.!qB) files.', { retry: true })
    kind = 'folder'
  } else if (info.isFile()) {
    if (staged.relative !== staged.top) throw new FinaliseError('unsafe-path', 'The download is a file where qBittorrent reports a folder.')
    if (PARTIAL.test(staged.top)) throw new FinaliseError('incomplete', 'The download is still an unfinished (.!qB) file.', { retry: true })
    kind = 'file'
  } else throw new FinaliseError('special-file', 'The download is not a regular file or folder.')
  const libraryInfo = await lstat(location.library)
  if (info.dev !== libraryInfo.dev) throw new FinaliseError('cross-device', 'The staging folder is on a different filesystem from the library, so the download cannot be moved in one step.')
  if (!await writable(location.staging) || !await writable(location.library) || (kind === 'folder' && !await writable(item))) throw new FinaliseError('permission', 'The agent is not allowed to move the download from staging into the library (check folder permissions and the agent\'s ReadWritePaths).')
  return { item, kind }
}

// Everything checked before Tomifin takes the torrent out of qBittorrent. Throws FinaliseError if it is not safe or
// possible to publish now; otherwise returns the plan.
export async function inspectStaged(destination, id, staged) {
  const location = await hostStaging(destination, id)
  if (!location.staging) throw new FinaliseError('missing', 'The download\'s staging folder is not there.', { retry: true })
  const { item, kind } = await checkItem(location, staged)
  const target = join(location.library, staged.top)
  if (await lstat(target).catch((error) => { if (missing(error)) return null; throw error })) throw new FinaliseError('conflict', `The ${destination.label} library already has something called "${staged.top}"; Tomifin never replaces it.`)
  return { ...location, item, target, kind, top: staged.top }
}

// Publishes the staged entry `top` of a job whose torrent is already out of qBittorrent. Safe to call again after an
// interruption at any point: it works out from the disk what is already done.
// Returns 'published' or 'already-published'.
export async function publishStagedItem(destination, id, top, { reserved = false } = {}) {
  if (!safeComponent(top)) throw new FinaliseError('unsafe-name', 'The download\'s name cannot be used in the library.')
  const location = await hostStaging(destination, id)
  const target = join(location.library, top)
  const item = location.staging ? join(location.staging, top) : null
  const [itemInfo, targetInfo] = await Promise.all([
    item ? lstat(item).catch((error) => { if (missing(error)) return null; throw error }) : null,
    lstat(target).catch((error) => { if (missing(error)) return null; throw error }),
  ])
  if (!itemInfo) {
    if (targetInfo) return 'already-published'
    throw new FinaliseError('missing', 'The downloaded files are no longer in the staging folder, and nothing of that name is in the library.')
  }
  if (targetInfo) {
    // Interrupted after the hardlink of a single file was made: finish by dropping the staging name.
    if (itemInfo.isFile() && targetInfo.isFile() && itemInfo.ino === targetInfo.ino && itemInfo.dev === targetInfo.dev) {
      await unlink(item)
      await fsyncDirectory(location.staging)
      return 'published'
    }
    // Interrupted after reserving the folder name: the reservation is an empty folder, which rmdir alone can remove.
    if (reserved && targetInfo.isDirectory() && !targetInfo.isSymbolicLink() && (await readdir(target)).length === 0) await rmdir(target)
    else throw new FinaliseError('conflict', `The ${destination.label} library already has something called "${top}"; Tomifin never replaces it.`)
  }
  const { kind } = await checkItem(location, { top, relative: top })
  if (kind === 'folder') {
    // mkdir fails if the name is taken, so the name is ours; renaming a folder onto an empty folder replaces only
    // that empty folder, and fails if anything was put into it meanwhile.
    await mkdir(target, { mode: 0o775 }).catch((error) => { throw error?.code === 'EEXIST' ? new FinaliseError('conflict', `Something called "${top}" appeared in the ${destination.label} library; it was not replaced.`) : error })
    try { await rename(item, target) }
    catch (error) {
      await rmdir(target).catch(() => {})
      if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw new FinaliseError('conflict', `Something called "${top}" appeared in the ${destination.label} library; it was not replaced.`)
      throw error
    }
  } else {
    await link(item, target).catch((error) => { throw error?.code === 'EEXIST' ? new FinaliseError('conflict', `Something called "${top}" appeared in the ${destination.label} library; it was not replaced.`) : error })
    await unlink(item)
  }
  await fsyncDirectory(location.library)
  await fsyncDirectory(location.staging)
  return 'published'
}

// Removes a job's staging folder only if it holds no files at all (empty subfolders are removed with it). Anything
// that is not a plain folder, or any file, leaves the whole folder untouched. Returns 'removed', 'absent' or 'kept'.
export async function removeEmptyStaging(destination, id) {
  const location = await hostStaging(destination, id)
  if (!location.staging) return 'absent'
  const folders = []
  let entries = 0
  async function empty(folder) {
    for (const name of await readdir(folder)) {
      if (++entries > 1000) return false
      const path = join(folder, name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) return false
      if (!await empty(path)) return false
    }
    folders.push(folder)
    return true
  }
  if (!await empty(location.staging)) return 'kept'
  // Deepest first (the order they were finished in); rmdir refuses any folder that is no longer empty.
  for (const folder of folders) await rmdir(folder)
  return 'removed'
}
