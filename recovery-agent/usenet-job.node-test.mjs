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
  const savedStatuses = []
  const releaseResult = { importedCount: 2, importedTracks: [{ path: '/recovery/01.flac' }, { path: '/recovery/02.flac' }], artist: 'Artist', album: 'Album' }
  const poll = createUsenetJobPoller({
    loadJob: async () => structuredClone(stored),
    saveJob: async (job) => { saveCalls += 1; savedStatuses.push(job.status); stored = structuredClone(job) },
    downloaderStatus: async () => { downloaderCalls += 1; return { status: 'completed', progress: 100, completedPath: '/downloads/release' } },
    completeJob: async () => { importCalls += 1; importStarted.release(); await allowImport.promise; return releaseResult },
    sanitizeError: (error) => error.message,
    now: () => '2026-10-15T00:00:00.000Z',
  })

  const first = poll('job-id')
  await importStarted.promise
  assert.deepEqual(savedStatuses, ['importing'])
  assert.equal(stored.status, 'importing')
  const second = poll('job-id')
  allowImport.release()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(downloaderCalls, 1)
  assert.equal(importCalls, 1)
  assert.equal(saveCalls, 2)
  assert.deepEqual(savedStatuses, ['importing', 'completed'])
  assert.deepEqual(firstResult, secondResult)
  assert.equal(firstResult.job.status, 'completed')
  assert.equal(firstResult.job.result.importedCount, 2)
  assert.equal(firstResult.job.result.importedTracks.length, 2)

  const laterResult = await poll('job-id')
  assert.deepEqual(laterResult, firstResult)
  assert.equal(downloaderCalls, 1)
  assert.equal(importCalls, 1)
  assert.equal(saveCalls, 2)
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

test('a download the downloader reports as failed keeps its reason as the job error', async () => {
  let stored = queuedJob()
  const poll = createUsenetJobPoller({
    loadJob: async () => structuredClone(stored),
    saveJob: async (job) => { stored = structuredClone(job) },
    downloaderStatus: async () => ({ status: 'failed', progress: 0, message: 'Aborted, cannot be completed - https://sabnzbd.org/not-complete' }),
    completeJob: async () => { throw new Error('should not import') },
    sanitizeError: (error) => error.message,
  })
  const result = await poll('job-id')
  assert.equal(result.job.status, 'failed')
  assert.equal(result.job.error, 'Aborted, cannot be completed - https://sabnzbd.org/not-complete')
  assert.equal((await poll('job-id')).job.error, result.job.error)
})

test('failed jobs saved before errors were recorded fall back to the downloader message', async () => {
  const poll = createUsenetJobPoller({
    loadJob: async () => ({ ...queuedJob(), status: 'failed', message: 'Repair failed, not enough repair blocks' }),
    saveJob: async () => {}, downloaderStatus: async () => { throw new Error('not called') }, completeJob: async () => {}, sanitizeError: (error) => error.message,
  })
  assert.equal((await poll('job-id')).job.error, 'Repair failed, not enough repair blocks')
})

test('live transfer details from the downloader are saved and returned, and settled waits for an active poll', async () => {
  let stored = queuedJob()
  const seen = []
  const gate = deferred()
  const poll = createUsenetJobPoller({
    loadJob: async () => structuredClone(stored),
    saveJob: async (job) => { stored = structuredClone(job) },
    downloaderStatus: async (remoteId, job) => { seen.push([remoteId, job.id]); await gate.promise; return { status: 'downloading', progress: 40, details: { downloadSpeed: 1000, seeds: 3 } } },
    completeJob: async () => { throw new Error('not completed') },
    sanitizeError: (error) => error.message,
  })
  const running = poll('job-id')
  let settled = false
  const waiting = poll.settled('job-id').then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  gate.release()
  const { job } = await running
  await waiting
  assert.equal(settled, true)
  assert.deepEqual(seen, [['remote-id', 'job-id']])
  assert.deepEqual(job.details, { downloadSpeed: 1000, seeds: 3 })
  assert.deepEqual(stored.details, { downloadSpeed: 1000, seeds: 3 })
  await poll.settled('no-active-poll')
})
