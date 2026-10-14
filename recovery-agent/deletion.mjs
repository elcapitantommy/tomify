import { lstat, readFile, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path'

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

async function existingRealPath(path) {
  try { return await realpath(path) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

export function recoveryArtifactPaths(importedPath, recoveryRoot, masterRoot = null, preservedOriginalPath = null) {
  if (typeof importedPath !== 'string' || !isAbsolute(importedPath)) throw new Error('An absolute imported recovery path is required.')
  const root = resolve(recoveryRoot)
  const imported = resolve(importedPath)
  const sourceDirectory = resolve(dirname(imported), '.tomify-source')
  const original = preservedOriginalPath ? resolve(preservedOriginalPath) : resolve(sourceDirectory, basename(imported))
  if (dirname(original) !== sourceDirectory || basename(original, extname(original)) !== basename(imported, extname(imported))) throw new Error('Preserved source path does not match the recovery derivative.')
  const paths = [imported, `${imported}.tomify.json`, original]
  if (imported === root || paths.some((path) => !inside(path, root))) throw new Error('Refusing to delete a path outside TOMIFY_RECOVERY_DIR.')
  if (masterRoot) {
    const master = resolve(masterRoot)
    if (paths.some((path) => inside(path, master))) throw new Error('Refusing to delete from the canonical master library.')
  }
  return paths
}

export async function deleteRecoveryArtifacts(importedPath, recoveryRoot, masterRoot = null) {
  const root = resolve(recoveryRoot)
  let paths = recoveryArtifactPaths(importedPath, root, masterRoot)
  const canonicalRoot = await realpath(root)
  const canonicalMaster = masterRoot ? await existingRealPath(resolve(masterRoot)) : null
  const canonicalSidecar = await existingRealPath(paths[1])
  if (canonicalSidecar) {
    if (!inside(canonicalSidecar, canonicalRoot)) throw new Error('Refusing to read provenance outside TOMIFY_RECOVERY_DIR.')
    if (canonicalMaster && inside(canonicalSidecar, canonicalMaster)) throw new Error('Refusing to read provenance from the canonical master library.')
    const sidecarDetails = await lstat(paths[1])
    if (!sidecarDetails.isFile()) throw new Error('Refusing to read recovery provenance that is not a regular file.')
  }
  try {
    const provenance = JSON.parse(await readFile(paths[1], 'utf8'))
    if (typeof provenance?.sourceAudio?.path === 'string') paths = recoveryArtifactPaths(importedPath, root, masterRoot, provenance.sourceAudio.path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Recovery provenance could not be read safely for deletion.')
  }
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
