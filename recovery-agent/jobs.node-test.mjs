import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobRunner, jobPollIntervalMs } from './jobs.mjs'
import { createUsenetJobPoller } from './usenet-job.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))

// A clock whose timers only fire when the test moves time forward.
function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { at: now + delay, callback }); return id },
    clearTimer: (id) => { timers.delete(id) },
    pending: () => [...timers.values()].map((timer) => timer.at - now),
    async advance(ms) {
      const until = now + ms
      for (;;) {
        await flush()
        const [id, due] = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0] || []
        if (!id) break
        timers.delete(id)
        now = due.at
        due.callback()
        for (let i = 0; i < 5; i += 1) await flush()
      }
      now = until
    },
  }
}

// An in-memory job store and a downloader that reports the given states in turn, then stays on the last.
function fakeAgent(jobs, states) {
  const store = new Map(jobs.map((job) => [job.id, structuredClone(job)]))
  const calls = { downloader: [], imports: [], saves: 0 }
  const loadJob = async (id) => {
    if (!store.has(id)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return structuredClone(store.get(id))
  }
  const poller = createUsenetJobPoller({
    loadJob,
    saveJob: async (job) => { calls.saves += 1; store.set(job.id, structuredClone(job)) },
    downloaderStatus: async (_remoteId, job) => { calls.downloader.push(job.id); const step = calls.downloader.filter((id) => id === job.id).length - 1; return states[Math.min(step, states.length - 1)] },
    completeJob: async (job) => { calls.imports.push(job.id); return { path: `/recovery/${job.id}.flac`, importedCount: 1 } },
    sanitizeError: (error) => error.message,
    now: () => '2026-10-16T00:00:00.000Z',
  })
  return { store, calls, poller, listJobs: async () => [...store.values()].map((job) => structuredClone(job)) }
}

const downloadStates = [
  { status: 'queued', progress: 0 },
  { status: 'downloading', progress: 50 },
  { status: 'completed', progress: 100, completedPath: '/downloads/job' },
]

test('a queued job with no client polling is downloaded and imported exactly once', async () => {
  const clock = fakeClock()
  const agent = fakeAgent([], downloadStates)
  const runner = createJobRunner({ listJobs: agent.listJobs, advance: agent.poller, intervalMs: 10_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await runner.start()
  agent.store.set('job-1', { id: 'job-1', remoteId: 'remote-1', status: 'queued', progress: 0 })
  runner.track('job-1')

  await clock.advance(0)
  assert.equal(agent.store.get('job-1').status, 'queued')
  await clock.advance(10_000)
  assert.equal(agent.store.get('job-1').status, 'downloading')
  assert.equal(agent.store.get('job-1').progress, 50)
  await clock.advance(10_000)
  assert.equal(agent.store.get('job-1').status, 'completed')
  assert.deepEqual(agent.store.get('job-1').importResult, { path: '/recovery/job-1.flac', importedCount: 1 })

  // Once the job is finished, later ticks leave it alone.
  await clock.advance(10 * 60_000)
  assert.deepEqual(agent.calls.imports, ['job-1'])
  assert.equal(agent.calls.downloader.length, 3)
  assert.deepEqual(runner.activeJobs(), [])
  await runner.stop()
})

test('a tick and a status request never import the same job twice', async () => {
  const clock = fakeClock()
  const agent = fakeAgent([{ id: 'job-1', remoteId: 'remote-1', status: 'downloading', progress: 90 }], [downloadStates[2]])
  let releaseImport
  const importGate = new Promise((resolve) => { releaseImport = resolve })
  const slowPoller = createUsenetJobPoller({
    loadJob: async (id) => structuredClone(agent.store.get(id)),
    saveJob: async (job) => { agent.store.set(job.id, structuredClone(job)) },
    downloaderStatus: async () => downloadStates[2],
    completeJob: async (job) => { agent.calls.imports.push(job.id); await importGate; return { importedCount: 1 } },
    sanitizeError: (error) => error.message,
  })
  const runner = createJobRunner({ listJobs: agent.listJobs, advance: slowPoller, intervalMs: 1_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await runner.start()
  await clock.advance(0)
  assert.equal(agent.store.get('job-1').status, 'importing')
  // Further ticks while the import runs, plus a status read, start nothing new.
  await clock.advance(5_000)
  assert.equal((await slowPoller.read('job-1')).job.status, 'importing')
  releaseImport()
  await clock.advance(1_000)
  assert.equal(agent.store.get('job-1').status, 'completed')
  assert.deepEqual(agent.calls.imports, ['job-1'])
  await runner.stop()
})

test('job status is read-only: it never asks the downloader, saves, or imports', async () => {
  const agent = fakeAgent([{ id: 'job-1', remoteId: 'remote-1', status: 'downloading', progress: 99 }], [downloadStates[2]])
  const before = structuredClone(agent.store.get('job-1'))
  const first = await agent.poller.read('job-1')
  const second = await agent.poller.read('job-1')
  assert.deepEqual(first, second)
  assert.equal(first.job.status, 'downloading')
  assert.equal(first.job.progress, 99)
  assert.deepEqual(agent.calls, { downloader: [], imports: [], saves: 0 })
  assert.deepEqual(agent.store.get('job-1'), before)
})

test('after a restart the runner resumes every unfinished job and leaves finished ones alone', async () => {
  const clock = fakeClock()
  const agent = fakeAgent([
    { id: 'queued-job', remoteId: 'r1', status: 'queued', progress: 0 },
    { id: 'importing-job', remoteId: 'r2', status: 'importing', progress: 100 },
    { id: 'done-job', remoteId: 'r3', status: 'completed', progress: 100, importResult: { importedCount: 1 } },
    { id: 'failed-job', remoteId: 'r4', status: 'failed', progress: 10, error: 'missing articles' },
  ], [downloadStates[2]])
  const runner = createJobRunner({ listJobs: agent.listJobs, advance: agent.poller, intervalMs: 10_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await runner.start()
  assert.deepEqual(runner.activeJobs().sort(), ['importing-job', 'queued-job'])
  await clock.advance(0)
  assert.equal(agent.store.get('queued-job').status, 'completed')
  assert.equal(agent.store.get('importing-job').status, 'completed')
  assert.deepEqual(agent.calls.imports.sort(), ['importing-job', 'queued-job'])
  assert.equal(agent.store.get('failed-job').status, 'failed')
  assert.ok(!agent.calls.downloader.includes('done-job') && !agent.calls.downloader.includes('failed-job'))
  await runner.stop()
})

test('the runner backs off while idle and returns to the normal interval when a job is queued', async () => {
  const clock = fakeClock()
  const agent = fakeAgent([], downloadStates)
  let scans = 0
  const listJobs = async () => { scans += 1; return agent.listJobs() }
  const runner = createJobRunner({ listJobs, advance: agent.poller, intervalMs: 10_000, maxIdleMs: 60_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await runner.start()
  await clock.advance(0)
  assert.deepEqual(clock.pending(), [20_000])
  await clock.advance(20_000)
  assert.deepEqual(clock.pending(), [40_000])
  await clock.advance(40_000)
  assert.deepEqual(clock.pending(), [60_000])
  await clock.advance(60_000)
  assert.deepEqual(clock.pending(), [60_000])
  assert.equal(scans, 5)
  agent.store.set('job-1', { id: 'job-1', remoteId: 'remote-1', status: 'queued', progress: 0 })
  runner.track('job-1')
  await clock.advance(0)
  assert.deepEqual(clock.pending(), [10_000])
  await runner.stop()
})

test('a cancelled job is dropped once its state file is gone', async () => {
  const clock = fakeClock()
  const agent = fakeAgent([{ id: 'job-1', remoteId: 'remote-1', status: 'downloading', progress: 20 }], [downloadStates[1]])
  const runner = createJobRunner({ listJobs: agent.listJobs, advance: agent.poller, intervalMs: 10_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await runner.start()
  await clock.advance(0)
  agent.store.delete('job-1')
  await clock.advance(10_000)
  assert.deepEqual(runner.activeJobs(), [])
  await runner.stop()
})

test('TOMIFY_JOB_POLL_SECONDS sets the interval, defaulting to ten seconds', () => {
  assert.equal(jobPollIntervalMs({}), 10_000)
  assert.equal(jobPollIntervalMs({ TOMIFY_JOB_POLL_SECONDS: '3' }), 3_000)
  assert.equal(jobPollIntervalMs({ TOMIFY_JOB_POLL_SECONDS: '0' }), 10_000)
  assert.equal(jobPollIntervalMs({ TOMIFY_JOB_POLL_SECONDS: 'soon' }), 10_000)
})
