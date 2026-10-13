import { lstat, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

async function existingRealPath(path) {
  try { return await realpath(path) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

export function recoveryArtifactPaths(importedPath, recoveryRoot, masterRoot = null) {
  if (typeof importedPath !== 'string' || !isAbsolute(importedPath)) throw new Error('An absolute imported recovery path is required.')
  const root = resolve(recoveryRoot)
  const imported = resolve(importedPath)
  const paths = [
    imported,
    `${imported}.tomify.json`,
    resolve(dirname(imported), '.tomify-source', basename(imported)),
  ]
  if (imported === root || paths.some((path) => !inside(path, root))) throw new Error('Refusing to delete a path outside TOMIFY_RECOVERY_DIR.')
  if (masterRoot) {
    const master = resolve(masterRoot)
    if (paths.some((path) => inside(path, master))) throw new Error('Refusing to delete from the canonical master library.')
  }
  return paths
}

export async function deleteRecoveryArtifacts(importedPath, recoveryRoot, masterRoot = null) {
  const root = resolve(recoveryRoot)
  const paths = recoveryArtifactPaths(importedPath, root, masterRoot)
  const canonicalRoot = await realpath(root)
  const canonicalMaster = masterRoot ? await existingRealPath(resolve(masterRoot)) : null

  for (const path of paths) {
    const canonicalPath = await existingRealPath(path)
    if (!canonicalPath) continue
    if (!inside(canonicalPath, canonicalRoot)) throw new Error('Refusing to delete an artifact that resolves outside TOMIFY_RECOVERY_DIR.')
    if (canonicalMaster && inside(canonicalPath, canonicalMaster)) throw new Error('Refusing to delete from the canonical master library.')
    const details = await lstat(path)
    if (!details.isFile()) throw new Error('Refusing to delete a recovery artifact that is not a regular file.')
  }

  const deleted = []
  for (const path of paths) {
    try { await unlink(path); deleted.push(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return { deleted }
}
