import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteRecoveryArtifacts, recoveryArtifactPaths } from './deletion.mjs'

test('deletes the derivative, sidecar, and matching preserved original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-delete-test-'))
  const album = join(root, 'Artist', 'Album')
  const source = join(album, '.tomify-source')
  await mkdir(source, { recursive: true })
  const imported = join(album, '01 - Track.webm')
  const paths = recoveryArtifactPaths(imported, root)
  await Promise.all(paths.map((path) => writeFile(path, 'test')))

  const result = await deleteRecoveryArtifacts(imported, root)
  assert.deepEqual(result.deleted.sort(), paths.sort())
  await Promise.all(paths.map((path) => assert.rejects(readFile(path), { code: 'ENOENT' })))
})

test('refuses paths outside the recovery root or inside the master tree', () => {
  const root = join(tmpdir(), 'recovery')
  const master = join(tmpdir(), 'music')
  assert.throws(() => recoveryArtifactPaths(join(tmpdir(), 'elsewhere', 'track.webm'), root, master), /outside TOMIFY_RECOVERY_DIR/)
  const unsafeRoot = join(master, 'recovery')
  assert.throws(() => recoveryArtifactPaths(join(unsafeRoot, 'track.webm'), unsafeRoot, master), /canonical master/)
})

test('treats already-missing artifacts as an idempotent success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-delete-test-'))
  const imported = join(root, 'Artist', 'Album', 'Track.webm')
  assert.deepEqual(await deleteRecoveryArtifacts(imported, root), { deleted: [] })
})
