import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAudioCache } from './cache.mjs'

async function withDir(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'tomtube-cache-test-'))
  try { await callback(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

async function* chunks(...parts) { for (const part of parts) yield Buffer.from(part) }

test('a filled file is served from the cache and touched when used', async () => withDir(async (dir) => {
  const cache = createAudioCache({ dir, maxBytes: 1000, maxAgeMs: 3600_000, maxFileBytes: 500 })
  assert.equal(await cache.lookup('aaaaaaaaaaa', '140'), null)
  const filled = await cache.fill('aaaaaaaaaaa', '140', 6, () => chunks('abc', 'def'))
  assert.equal(filled.size, 6)
  const found = await cache.lookup('aaaaaaaaaaa', '140')
  assert.equal(await readFile(found.path, 'utf8'), 'abcdef')
  assert.deepEqual(await readdir(dir), ['aaaaaaaaaaa.140.m4a'])
}))

test('a failed or short download leaves no file behind', async () => withDir(async (dir) => {
  const cache = createAudioCache({ dir, maxBytes: 1000, maxAgeMs: 3600_000, maxFileBytes: 500 })
  async function* broken() { yield Buffer.from('abc'); throw new Error('network') }
  assert.equal(await cache.fill('aaaaaaaaaaa', '140', 6, broken), null)
  assert.equal(await cache.fill('bbbbbbbbbbb', '140', 6, () => chunks('abc')), null)
  assert.equal(await cache.fill('ccccccccccc', '140', 2, () => chunks('abc')), null)
  assert.deepEqual(await readdir(dir), [])
}))

test('files over the per-file limit are not cached', async () => withDir(async (dir) => {
  const cache = createAudioCache({ dir, maxBytes: 1000, maxAgeMs: 3600_000, maxFileBytes: 4 })
  assert.equal(await cache.fill('aaaaaaaaaaa', '140', 6, () => chunks('abcdef')), null)
  assert.deepEqual(await readdir(dir).catch(() => []), [])
}))

test('the least recently used files go first when the cache is full', async () => withDir(async (dir) => {
  let clock = Date.now()
  const cache = createAudioCache({ dir, maxBytes: 10, maxAgeMs: 3600_000, maxFileBytes: 10, now: () => clock })
  await cache.fill('aaaaaaaaaaa', '140', 4, () => chunks('aaaa'))
  await utimes(join(dir, 'aaaaaaaaaaa.140.m4a'), new Date(clock - 3000), new Date(clock - 3000))
  await cache.fill('bbbbbbbbbbb', '140', 4, () => chunks('bbbb'))
  await utimes(join(dir, 'bbbbbbbbbbb.140.m4a'), new Date(clock - 2000), new Date(clock - 2000))
  clock += 10
  await cache.lookup('aaaaaaaaaaa', '140') // a is now the most recently used
  await cache.fill('ccccccccccc', '140', 4, () => chunks('cccc'))
  assert.deepEqual((await readdir(dir)).sort(), ['aaaaaaaaaaa.140.m4a', 'ccccccccccc.140.m4a'])
}))

test('a sweep removes expired files, stray files and stale partial downloads', async () => withDir(async (dir) => {
  const now = Date.now()
  const cache = createAudioCache({ dir, maxBytes: 1000, maxAgeMs: 60_000, maxFileBytes: 100, partMaxAgeMs: 60_000, now: () => now })
  await writeFile(join(dir, 'aaaaaaaaaaa.140.m4a'), 'old')
  await utimes(join(dir, 'aaaaaaaaaaa.140.m4a'), new Date(now - 120_000), new Date(now - 120_000))
  await writeFile(join(dir, 'bbbbbbbbbbb.140.m4a'), 'new')
  await writeFile(join(dir, 'ccccccccccc.140.m4a.1.x.part'), 'stale')
  await utimes(join(dir, 'ccccccccccc.140.m4a.1.x.part'), new Date(now - 120_000), new Date(now - 120_000))
  await writeFile(join(dir, 'ddddddddddd.140.m4a.1.y.part'), 'in progress')
  await writeFile(join(dir, 'notes.txt'), 'stray')
  assert.equal(await cache.lookup('aaaaaaaaaaa', '140'), null, 'expired files are not served')
  const result = await cache.sweep()
  assert.equal(result.files, 1)
  assert.deepEqual((await readdir(dir)).sort(), ['bbbbbbbbbbb.140.m4a', 'ddddddddddd.140.m4a.1.y.part'])
  await cache.sweep({ startup: true })
  assert.deepEqual(await readdir(dir), ['bbbbbbbbbbb.140.m4a'], 'at start-up every partial file is removed')
}))

test('cache keys cannot name a path outside the cache', async () => withDir(async (dir) => {
  const cache = createAudioCache({ dir, maxBytes: 1000, maxAgeMs: 60_000, maxFileBytes: 100 })
  assert.throws(() => cache.pathFor('../../../etc', '140'), TypeError)
  assert.throws(() => cache.pathFor('aaaaaaaaaaa', '../x'), TypeError)
}))
