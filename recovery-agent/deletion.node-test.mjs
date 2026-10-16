import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteRecoveryArtifacts, recoveryArtifactPaths } from './deletion.mjs'

test('moves the derivative, sidecar, and matching preserved original into the recovery trash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-delete-test-'))
  const album = join(root, 'Artist', 'Album')
  const source = join(album, '.tomify-source')
  await mkdir(source, { recursive: true })
  const imported = join(album, '01 - Track.webm')
  const paths = recoveryArtifactPaths(imported, root)
  await writeFile(paths[0], 'test')
  await writeFile(paths[1], JSON.stringify({ sourceAudio: { path: paths[2] } }))
  await writeFile(paths[2], 'test')

  const result = await deleteRecoveryArtifacts(imported, root, null, { now: () => new Date('2026-10-15T08:57:00.000Z') })
  assert.deepEqual(result.deleted.sort(), paths.sort())
  await Promise.all(paths.map((path) => assert.rejects(readFile(path), { code: 'ENOENT' })))
  // Nothing is erased: every file keeps its place under a timestamped trash folder, which Navidrome ignores.
  const trash = join(root, '.tomify-deleted', '2026-10-15T08-57-00-000Z')
  assert.deepEqual(result.trashed.sort(), paths.map((path) => join(trash, relative(root, path))).sort())
  assert.equal(await readFile(join(trash, 'Artist', 'Album', '01 - Track.webm'), 'utf8'), 'test')
  assert.equal((await stat(join(root, '.tomify-deleted', '.ndignore'))).size, 0)
})

test('a second deletion of the same path in the same instant does not overwrite the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-delete-test-'))
  const album = join(root, 'Artist', 'Album')
  await mkdir(album, { recursive: true })
  const imported = join(album, '01 - Track.flac')
  const now = () => new Date('2026-10-16T21:00:00.000Z')
  await writeFile(imported, 'first')
  const first = await deleteRecoveryArtifacts(imported, root, null, { now })
  await writeFile(imported, 'second')
  const second = await deleteRecoveryArtifacts(imported, root, null, { now })
  assert.equal(await readFile(first.trashed[0], 'utf8'), 'first')
  assert.equal(await readFile(second.trashed[0], 'utf8'), 'second')
})

test('moves a .opus derivative and its preserved .webm original from provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-delete-test-'))
  const album = join(root, 'Artist', 'Album')
  const source = join(album, '.tomify-source')
  await mkdir(source, { recursive: true })
  const imported = join(album, '01 - Track.opus')
  const original = join(source, '01 - Track.webm')
  const sidecar = `${imported}.tomify.json`
  await writeFile(imported, 'derivative')
  await writeFile(original, 'original')
  await writeFile(sidecar, JSON.stringify({ sourceAudio: { path: original } }))

  const result = await deleteRecoveryArtifacts(imported, root)
  assert.deepEqual(result.deleted.sort(), [imported, sidecar, original].sort())
  await Promise.all([imported, sidecar, original].map((path) => assert.rejects(readFile(path), { code: 'ENOENT' })))
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
  assert.deepEqual(await deleteRecoveryArtifacts(imported, root), { deleted: [], trashed: [] })
})
