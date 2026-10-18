import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLoudnessTagger, loudnessAlbums, rsgainArguments } from './loudness.mjs'
import { createImportRecovery, importStatePaths, loadImportManifest, prepareImportStaging, runManifestImport, sha256File } from './manifest.mjs'

const staging = '/state/import-staging/job'
const entry = (role, source, destination) => ({ role, source, destination })

// A stand-in for child_process.spawn: each call records its arguments and exits with the next outcome.
function fakeSpawn(outcomes) {
  const calls = []
  const spawn = (command, args) => {
    calls.push({ command, args })
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    const outcome = outcomes.shift() ?? 0
    queueMicrotask(() => {
      if (outcome instanceof Error) child.emit('error', outcome)
      else {
        if (outcome) child.stderr.emit('data', 'Error: could not read file\n')
        child.emit('close', outcome, null)
      }
    })
    return child
  }
  return { spawn, calls }
}

test('loudness tagging covers staged derivatives, grouped by album folder', () => {
  const albums = loudnessAlbums([
    entry('original', '/downloads/Flood/01.flac', '/recovery/.tomify-source/TMBG/Flood/01.flac'),
    entry('derivative', `${staging}/0.flac`, '/recovery/TMBG/Flood/01 Theme from Flood.flac'),
    entry('sidecar', `${staging}/0.tomify.json`, '/recovery/TMBG/Flood/01 Theme from Flood.flac.tomify.json'),
    entry('derivative', `${staging}/1.flac`, '/recovery/TMBG/Flood/02 Birdhouse in Your Soul.flac'),
    entry('derivative', `${staging}/2.m4a`, '/recovery/TMBG/Lincoln/01 Ana Ng.M4A'),
    entry('cover', `${staging}/cover.jpg`, '/recovery/TMBG/Flood/cover.jpg'),
  ], staging)
  assert.deepEqual(albums, [[`${staging}/0.flac`, `${staging}/1.flac`], [`${staging}/2.m4a`]])
})

test('loudness tagging never touches a file outside the staging directory or one rsgain cannot tag', () => {
  assert.deepEqual(loudnessAlbums([
    entry('derivative', '/downloads/Flood/01.flac', '/recovery/TMBG/Flood/01.flac'),
    entry('derivative', '/state/import-staging/job-other/0.flac', '/recovery/TMBG/Flood/02.flac'),
    entry('derivative', `${staging}/0.mka`, '/recovery/TMBG/Flood/03.mka'),
  ], staging), [])
})

test('rsgain writes ReplayGain 2.0 track and album tags', () => {
  assert.deepEqual(rsgainArguments(['/a/1.flac', '/a/2.flac']), ['custom', '-a', '-s', 'i', '-q', '/a/1.flac', '/a/2.flac'])
})

test('tagging runs rsgain once per album and counts the files', async () => {
  const { spawn, calls } = fakeSpawn([0, 0])
  const tag = createLoudnessTagger({ rsgain: '/usr/bin/rsgain', spawn, log: () => {} })
  const outcome = await tag([
    entry('derivative', `${staging}/0.flac`, '/recovery/A/X/1.flac'),
    entry('derivative', `${staging}/1.flac`, '/recovery/A/X/2.flac'),
    entry('derivative', `${staging}/2.flac`, '/recovery/A/Y/1.flac'),
  ], staging)
  assert.deepEqual(outcome, { tagged: 3, failed: 0 })
  assert.deepEqual(calls.map((call) => [call.command, call.args.slice(5)]), [['/usr/bin/rsgain', [`${staging}/0.flac`, `${staging}/1.flac`]], ['/usr/bin/rsgain', [`${staging}/2.flac`]]])
})

test('tagging is off without RSGAIN_PATH', async () => {
  const { spawn, calls } = fakeSpawn([])
  const outcome = await createLoudnessTagger({ rsgain: '', spawn })([entry('derivative', `${staging}/0.flac`, '/recovery/A/X/1.flac')], staging)
  assert.deepEqual(outcome, { tagged: 0, failed: 0 })
  assert.equal(calls.length, 0)
})

test('a failed album is logged and the next album is still tagged', async () => {
  const { spawn } = fakeSpawn([1, 0])
  const logged = []
  const outcome = await createLoudnessTagger({ rsgain: 'rsgain', spawn, log: (message) => logged.push(message) })([
    entry('derivative', `${staging}/0.flac`, '/recovery/A/X/1.flac'),
    entry('derivative', `${staging}/1.flac`, '/recovery/A/Y/1.flac'),
  ], staging)
  assert.deepEqual(outcome, { tagged: 1, failed: 1 })
  assert.deepEqual(logged, ['ReplayGain tagging failed for 1 file: Error: could not read file'])
})

test('a missing rsgain turns tagging off instead of failing every import', async () => {
  const missing = Object.assign(new Error('spawn rsgain ENOENT'), { code: 'ENOENT' })
  const { spawn, calls } = fakeSpawn([missing])
  const logged = []
  const tag = createLoudnessTagger({ rsgain: 'rsgain', spawn, log: (message) => logged.push(message) })
  const entries = [entry('derivative', `${staging}/0.flac`, '/recovery/A/X/1.flac'), entry('derivative', `${staging}/1.flac`, '/recovery/A/Y/1.flac')]
  assert.deepEqual(await tag(entries, staging), { tagged: 0, failed: 1 })
  assert.deepEqual(await tag(entries, staging), { tagged: 0, failed: 0 })
  assert.equal(calls.length, 1)
  assert.deepEqual(logged, ['ReplayGain tagging is off: rsgain was not found.'])
})

test('an import commits the tagged derivative and its manifest records the tagged file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tomify-loudness-test-'))
  try {
    const stateRoot = join(base, 'state')
    const recoveryRoot = join(base, 'recovery')
    const download = join(base, 'downloads', 'one.flac')
    await mkdir(join(base, 'downloads'), { recursive: true })
    await writeFile(download, 'original audio')
    const stagingRoot = await prepareImportStaging(stateRoot, 'tag-job')
    await writeFile(join(stagingRoot, '0.flac'), 'derivative audio')
    const entries = [
      entry('original', download, join(recoveryRoot, '.tomify-source', 'A', 'X', 'one.flac')),
      entry('derivative', join(stagingRoot, '0.flac'), join(recoveryRoot, 'A', 'X', 'one.flac')),
    ]
    const seen = []
    const tagLoudness = async (planned, root) => {
      seen.push(root)
      for (const files of loudnessAlbums(planned, root)) for (const file of files) await writeFile(file, `${await readFile(file, 'utf8')} +REPLAYGAIN`)
    }
    await runManifestImport({ stateRoot, id: 'tag-job', jobId: 'tag-job', kind: 'usenet', root: recoveryRoot, entries, result: {}, tagLoudness })
    assert.deepEqual(seen, [stagingRoot])
    assert.equal(await readFile(join(recoveryRoot, 'A', 'X', 'one.flac'), 'utf8'), 'derivative audio +REPLAYGAIN')
    assert.equal(await readFile(download, 'utf8'), 'original audio')
    const manifest = await loadImportManifest(importStatePaths(stateRoot, 'tag-job').manifestPath)
    assert.equal(manifest.data.entries[1].sha256, await sha256File(join(recoveryRoot, 'A', 'X', 'one.flac')))
    // A restart before the job is saved still sees the tagged file as this import's own.
    assert.equal((await createImportRecovery({ stateRoot, recoveryRoot }).resume('tag-job')).status, 'completed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
