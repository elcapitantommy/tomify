import { constants as fsConstants } from 'node:fs'
import { access, copyFile, link, realpath, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

function hiddenTemporaryPath(destination, randomId) {
  return join(dirname(destination), `.${basename(destination)}.${randomId()}.tomify-tmp`)
}

async function publishExclusive(temporaryPath, destination, linkFile) {
  // A same-directory hard link is an atomic no-replace publish. Node's rename() would overwrite on POSIX.
  await linkFile(temporaryPath, destination)
}

export async function commitTrackFiles({ originalSource, derivativeSource, originalPath, derivativePath }, dependencies = {}) {
  const copy = dependencies.copyFile || copyFile
  const linkFile = dependencies.link || link
  const remove = dependencies.unlink || unlink
  const randomId = dependencies.randomUUID || randomUUID
  const originalTemporary = hiddenTemporaryPath(originalPath, randomId)
  const derivativeTemporary = hiddenTemporaryPath(derivativePath, randomId)
  const committed = []
  try {
    await copy(originalSource, originalTemporary, fsConstants.COPYFILE_EXCL)
    await copy(derivativeSource, derivativeTemporary, fsConstants.COPYFILE_EXCL)
    await publishExclusive(originalTemporary, originalPath, linkFile)
    committed.push(originalPath)
    await publishExclusive(derivativeTemporary, derivativePath, linkFile)
    committed.push(derivativePath)
    return { originalPath, derivativePath }
  } catch (error) {
    for (const path of committed.reverse()) await remove(path).catch(() => {})
    throw error
  } finally {
    await remove(derivativeTemporary).catch(() => {})
    await remove(originalTemporary).catch(() => {})
  }
}

export async function commitCoverFile(sourcePath, destination, dependencies = {}) {
  const inspect = dependencies.access || access
  const copy = dependencies.copyFile || copyFile
  const linkFile = dependencies.link || link
  const remove = dependencies.unlink || unlink
  const randomId = dependencies.randomUUID || randomUUID
  try {
    await inspect(destination)
    return { created: false, existingCoverKept: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temporaryPath = hiddenTemporaryPath(destination, randomId)
  try {
    await copy(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL)
    try { await publishExclusive(temporaryPath, destination, linkFile) }
    catch (error) {
      if (error?.code === 'EEXIST') return { created: false, existingCoverKept: true }
      throw error
    }
    return { created: true, existingCoverKept: false }
  } finally {
    await remove(temporaryPath).catch(() => {})
  }
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

export async function cleanupCompletedDownload(completedPath, downloadRoot, dependencies = {}) {
  if (!completedPath || !downloadRoot) return false
  const resolveRealPath = dependencies.realpath || realpath
  const inspect = dependencies.stat || stat
  const remove = dependencies.rm || rm
  const canonicalRoot = await resolveRealPath(resolve(downloadRoot))
  const canonicalTarget = await resolveRealPath(resolve(completedPath))
  if (canonicalTarget === canonicalRoot || !inside(canonicalTarget, canonicalRoot)) return false
  if (!(await inspect(canonicalTarget)).isDirectory()) return false
  await remove(canonicalTarget, { recursive: true, force: false })
  return true
}
