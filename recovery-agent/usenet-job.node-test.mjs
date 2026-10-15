import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsenetJobPoller } from './usenet-job.mjs'

function deferred() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

function queuedJob() {
  return { id: 'job-id', remoteId: 'remote-id', status: 'queued', progress: 0 }
}

test('concurrent status requests run one completed release import and share its result', async () => {
  let stored = queuedJob()
  let downloaderCalls = 0
  let importCalls = 0
  let saveCalls = 0
  const importStarted = deferred()
  const allowImport = deferred()
  const releaseResult = { importedCount: 2, importedTracks: [{ path: '/recovery/01.flac' }, { path: '/recovery/02.flac' }], artist: 'Artist', album: 'Album' }
  const poll = createUsenetJobPoller({
    loadJob: async () => structuredClone(stored),
    saveJob: async (job) => { saveCalls += 1; stored = structuredClone(job) },
    downloaderStatus: async () => { downloaderCalls += 1; return { status: 'completed', progress: 100, completedPath: '/downloads/release' } },
    completeJob: async () => { importCalls += 1; importStarted.release(); await allowImport.promise; return releaseResult },
    sanitizeError: (error) => error.message,
    now: () => '2026-10-15T00:00:00.000Z',
  })

  const first = poll('job-id')
  await importStarted.promise
  const second = poll('job-id')
  allowImport.release()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(downloaderCalls, 1)
  assert.equal(importCalls, 1)
  assert.equal(saveCalls, 1)
  assert.deepEqual(firstResult, secondResult)
  assert.equal(firstResult.job.status, 'completed')
  assert.equal(firstResult.job.result.importedCount, 2)
  assert.equal(firstResult.job.result.importedTracks.length, 2)

  const laterResult = await poll('job-id')
  assert.deepEqual(laterResult, firstResult)
  assert.equal(downloaderCalls, 1)
  assert.equal(importCalls, 1)
  assert.equal(saveCalls, 1)
})

test('completed jobs return their persisted result without downloader or import work', async () => {
  const importResult = { importedCount: 1, importedTracks: [{ path: '/recovery/track.flac' }] }
  let downloaderCalls = 0
  let importCalls = 0
  let saveCalls = 0
  const poll = createUsenetJobPoller({
    loadJob: async () => ({ ...queuedJob(), status: 'completed', progress: 100, importResult }),
    saveJob: async () => { saveCalls += 1 },
    downloaderStatus: async () => { downloaderCalls += 1 },
    completeJob: async () => { importCalls += 1 },
    sanitizeError: (error) => error.message,
  })

  const first = await poll('job-id')
  const second = await poll('job-id')

  assert.deepEqual(first, second)
  assert.deepEqual(first.job.result, importResult)
  assert.equal(downloaderCalls, 0)
  assert.equal(importCalls, 0)
  assert.equal(saveCalls, 0)
})
