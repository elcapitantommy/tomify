import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findCompletedAudio } from './usenet.mjs'
import { importUsenetCompletion } from './usenet-import.mjs'
import { createJobRunner } from './jobs.mjs'
import { createImportRecovery, importStatePaths, prepareImportStaging, runManifestImport } from './manifest.mjs'

const jobId = '6f1c2a4e-0d7b-4c39-9a52-3b8e1f0c7d21'
const titles = ['Theme from Flood', 'Birdhouse in Your Soul', 'Lucky Ball and Chain', 'Istanbul (Not Constantinople)']

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function releaseJob() {
  return {
    id: jobId, version: 1, status: 'importing', progress: 0, downloader: 'sabnzbd', remoteId: 'SABnzbd_nzo_1', indexer: { type: 'nzbindex', id: 'nzbindex', name: 'NZBIndex' },
    result: { externalId: 'external', resultId: 'result-id', title: 'Flood', detailsUrl: 'https://www.nzbindex.com/collection/result-id', searchMode: 'release', postedAt: null, size: 1234, ageDays: 2 },
    request: { track: { artist: 'They Might Be Giants', album: 'Flood' }, wantedMetadata: null, catalogueSource: null, metadataResolution: null, artwork: null, authorisation: { basis: 'other-authorisation', confirmedBy: 'tom', confirmedAt: '2026-01-01T00:00:00.000Z' } },
  }
}

// Four completed tracks, an agent whose import "crashes" (stops dead, with no clean-up) once the second track's files
// are committed, and an in-memory job store shared with the restarted runner.
async function interruptedImport() {
  const base = await mkdtemp(join(tmpdir(), 'tomify-manifest-test-'))
  const recoveryRoot = join(base, 'recovery')
  const stateRoot = join(base, 'state')
  const completed = join(base, 'completed', 'Flood')
  await mkdir(completed, { recursive: true })
  const qualities = {}
  for (const [index, title] of titles.entries()) {
    const path = join(completed, `0${index + 1} - ${title}.flac`)
    await writeFile(path, `${title} audio`)
    qualities[path] = { codec: 'flac', container: 'flac', duration: 180, tags: { title, track: String(index + 1), album: 'Flood', artist: 'They Might Be Giants' } }
  }
  const store = new Map([[jobId, releaseJob()]])
  const { files } = await findCompletedAudio(completed)
  let crashed
  const crash = new Promise((resolve) => { crashed = resolve })
  let sidecars = 0
  const options = {
    recoveryRoot, stateRoot, importId: jobId,
    probe: async (path) => qualities[path] || { codec: 'flac', container: 'flac', duration: 180, tags: {} },
    prepareArtwork: async () => null,
    run: async (_command, args) => { await writeFile(args.at(-1), `derivative of ${basename(args[args.indexOf('-i') + 1])}`); return { stdout: '', stderr: '' } },
    ffmpeg: 'ffmpeg',
    // Each track commits its original, derivative and sidecar; after the second track's sidecar the agent dies.
    afterCommit: (entry) => {
      if (entry.role !== 'sidecar' || ++sidecars !== 2) return
      crashed()
      return new Promise(() => {})
    },
  }
  void importUsenetCompletion(store.get(jobId), files, options)
  await crash
  const album = join(recoveryRoot, 'They Might Be Giants', 'Flood')
  const destinations = titles.map((title, index) => {
    const stem = `0${index + 1} - ${title}`
    return { original: join(album, '.tomify-source', `${stem}.flac`), derivative: join(album, `${stem}.flac`), sidecar: join(album, `${stem}.flac.tomify.json`) }
  })
  return { base, recoveryRoot, stateRoot, completed, store, album, destinations }
}

// Starts a fresh runner, as the agent does after a restart, and lets its start-up recovery run.
async function restartRunner({ store, stateRoot, recoveryRoot }) {
  const advanced = []
  const logs = []
  const runner = createJobRunner({
    listJobs: async () => [...store.values()].map((job) => structuredClone(job)),
    saveJob: async (job) => { store.set(job.id, structuredClone(job)) },
    advance: async (id) => { advanced.push(id); return { job: store.get(id) } },
    imports: createImportRecovery({ stateRoot, recoveryRoot }),
    setTimer: () => null,
    clearTimer: () => {},
    log: (message) => logs.push(message),
  })
  await runner.start()
  await runner.stop()
  return { advanced, logs, runner }
}

test('an import interrupted after the second of four tracks is completed when the runner restarts', async () => {
  const agent = await interruptedImport()
  try {
    const { manifestPath } = importStatePaths(agent.stateRoot, jobId)
    const before = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(before.state, 'committing')
    assert.equal(before.entries.length, 12)
    assert.equal(before.entries.filter((entry) => entry.status === 'committed').length, 6)
    assert.equal(await exists(agent.destinations[2].derivative), false)
    assert.equal(agent.store.get(jobId).status, 'importing')

    const { advanced } = await restartRunner(agent)

    const job = agent.store.get(jobId)
    assert.equal(job.status, 'completed')
    assert.equal(job.importResult.importedCount, 4)
    assert.deepEqual(job.importResult.importedTracks.map((track) => track.title), titles)
    for (const [index, title] of titles.entries()) {
      const paths = agent.destinations[index]
      assert.equal(await readFile(paths.original, 'utf8'), `${title} audio`)
      assert.equal(await readFile(paths.derivative, 'utf8'), `derivative of 0${index + 1} - ${title}.flac`)
      assert.equal(JSON.parse(await readFile(paths.sidecar, 'utf8')).releaseImport.importedTrackNumber, index + 1)
    }
    // Only the four tracks, with no hidden temporaries left beside them.
    assert.deepEqual((await readdir(agent.album)).sort(), [...agent.destinations.flatMap((paths) => [basename(paths.derivative), basename(paths.sidecar)]), '.tomify-source'].sort())
    assert.equal(await exists(manifestPath), false)
    assert.equal(await exists(importStatePaths(agent.stateRoot, jobId).stagingRoot), false)
    assert.deepEqual(advanced, [], 'a recovered job is not imported again')
  } finally {
    await rm(agent.base, { recursive: true, force: true })
  }
})

test('an interrupted import whose downloaded files are gone is rolled back when the runner restarts', async () => {
  const agent = await interruptedImport()
  try {
    await rm(agent.completed, { recursive: true, force: true })

    await restartRunner(agent)

    const job = agent.store.get(jobId)
    assert.equal(job.status, 'failed')
    assert.match(job.error, /interrupted and 2 source files it still needed are gone, so Tomify removed the files it had already added/)
    for (const paths of agent.destinations) for (const path of Object.values(paths)) assert.equal(await exists(path), false, path)
    assert.deepEqual(await readdir(agent.album), ['.tomify-source'])
    assert.deepEqual(await readdir(join(agent.album, '.tomify-source')), [])
    assert.equal(await exists(importStatePaths(agent.stateRoot, jobId).manifestPath), false)
  } finally {
    await rm(agent.base, { recursive: true, force: true })
  }
})

test('a committed destination whose sha256 no longer matches is left alone and reported', async () => {
  const agent = await interruptedImport()
  try {
    // Something replaced the second track's derivative while the agent was down.
    const changed = agent.destinations[1].derivative
    await rm(changed)
    await writeFile(changed, 'a different recording')

    const { logs } = await restartRunner(agent)

    const job = agent.store.get(jobId)
    assert.equal(job.status, 'failed')
    assert.match(job.error, /1 file in the recovery library changed while the import was interrupted, so Tomify left it in place/)
    assert.equal(job.error.includes(changed), true)
    assert.deepEqual(job.importConflicts, [changed])
    assert.equal(logs.some((line) => line.includes(changed)), true)
    assert.equal(await readFile(changed, 'utf8'), 'a different recording')
    // Everything else this import committed is removed, and nothing more is added.
    for (const [index, paths] of agent.destinations.entries()) {
      for (const path of Object.values(paths)) if (path !== changed) assert.equal(await exists(path), false, `${index}: ${path}`)
    }
  } finally {
    await rm(agent.base, { recursive: true, force: true })
  }
})

test('a direct import resumed after a restart counts files already in place and keeps a cover that appeared meanwhile', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tomify-direct-manifest-test-'))
  try {
    const stateRoot = join(base, 'state')
    const recoveryRoot = join(base, 'recovery')
    const album = join(recoveryRoot, 'Artist', 'Album')
    await mkdir(join(album, '.tomify-source'), { recursive: true })
    const staging = await prepareImportStaging(stateRoot, jobId)
    for (const name of ['source.webm', 'cover.jpg', 'derivative.opus', 'sidecar.tomify.json']) await writeFile(join(staging, name), `${name} contents`)
    const entries = [
      { role: 'cover', source: join(staging, 'cover.jpg'), destination: join(album, 'cover.jpg'), optional: true },
      { role: 'original', source: join(staging, 'source.webm'), destination: join(album, '.tomify-source', 'Song.webm') },
      { role: 'derivative', source: join(staging, 'derivative.opus'), destination: join(album, 'Song.opus') },
      { role: 'sidecar', source: join(staging, 'sidecar.tomify.json'), destination: join(album, 'Song.opus.tomify.json') },
    ]
    let crashed
    const crash = new Promise((resolve) => { crashed = resolve })
    void runManifestImport({ stateRoot, id: jobId, jobId, kind: 'youtube', root: recoveryRoot, entries, result: { path: join(album, 'Song.opus') }, afterCommit: (_entry, index) => { if (index === 1) { crashed(); return new Promise(() => {}) } } })
    await crash
    await rm(join(album, 'cover.jpg'))
    await writeFile(join(album, 'cover.jpg'), 'a cover chosen by hand')
    const store = new Map([[jobId, { ...releaseJob(), downloader: 'youtube' }]])

    await restartRunner({ store, stateRoot, recoveryRoot })

    assert.equal(store.get(jobId).status, 'completed')
    assert.deepEqual(store.get(jobId).importResult, { path: join(album, 'Song.opus') })
    assert.equal(await readFile(join(album, 'cover.jpg'), 'utf8'), 'a cover chosen by hand')
    assert.equal(await readFile(join(album, 'Song.opus'), 'utf8'), 'derivative.opus contents')
    assert.equal(await readFile(join(album, '.tomify-source', 'Song.webm'), 'utf8'), 'source.webm contents')
    assert.equal(await readFile(join(album, 'Song.opus.tomify.json'), 'utf8'), 'sidecar.tomify.json contents')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a failure during an import removes what it committed and leaves no manifest for an import with no job', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tomify-manifest-failure-test-'))
  try {
    const stateRoot = join(base, 'state')
    const album = join(base, 'recovery', 'Album')
    await mkdir(album, { recursive: true })
    const staging = await prepareImportStaging(stateRoot, 'adhoc-import')
    for (const name of ['one', 'two']) await writeFile(join(staging, name), name)
    await writeFile(join(album, 'two.flac'), 'already here')
    const entries = [{ role: 'original', source: join(staging, 'one'), destination: join(album, 'one.flac') }, { role: 'derivative', source: join(staging, 'two'), destination: join(album, 'two.flac') }]
    await assert.rejects(runManifestImport({ stateRoot, id: 'adhoc-import', kind: 'usenet', root: join(base, 'recovery'), entries, result: {} }), /different file already exists/)
    assert.deepEqual((await readdir(album)).sort(), ['two.flac'])
    assert.equal(await readFile(join(album, 'two.flac'), 'utf8'), 'already here')
    assert.equal(await exists(importStatePaths(stateRoot, 'adhoc-import').manifestPath), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
