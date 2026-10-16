// Advances recovery jobs on a timer so downloads and imports finish with no browser open. Each tick runs every
// active job through `advance` (the per-job locked poller in usenet-job.mjs), so a tick never imports a job twice.
// On start-up it first settles imports a crash or restart interrupted, using their manifests (manifest.mjs).
const terminalStatuses = new Set(['completed', 'failed'])

export function isTerminalJob(job) {
  return terminalStatuses.has(job?.status)
}

export function jobPollIntervalMs(env = process.env) {
  const seconds = Number(env.TOMIFY_JOB_POLL_SECONDS)
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'unknown error'
}

// Settles every import that has a manifest left over from before a restart. A job left `importing` is resumed or
// rolled back and saved as completed or failed; a job already completed or failed just has its manifest discarded;
// a manifest whose job is gone is rolled back. Returns the ids that could not be settled, to retry later.
export async function recoverInterruptedImports({ listJobs, saveJob, imports, onRecovered = null, now = () => new Date().toISOString(), log = () => {}, only = null }) {
  const jobs = new Map((await listJobs()).filter((job) => job?.id).map((job) => [String(job.id), job]))
  const unsettled = new Set()
  for (const id of await imports.manifestIds()) {
    if (only && !only.has(id)) continue
    const job = jobs.get(id)
    try {
      if (job && isTerminalJob(job)) { await imports.discard(id); continue }
      // Only a job the poller was importing can have a manifest; leave anything else for the poller.
      if (job && job.status !== 'importing') continue
      if (!job) {
        const rollback = await imports.rollback(id)
        if (rollback.conflicts.length) log(`Interrupted import ${id} had no job; changed files were left in place: ${rollback.conflicts.join(', ')}`)
        await imports.discard(id)
        continue
      }
      const outcome = await imports.resume(id)
      const updated = { ...job, updatedAt: now() }
      if (outcome.status === 'completed') Object.assign(updated, { status: 'completed', progress: 100, message: null, error: null, details: null, importResult: outcome.result })
      else Object.assign(updated, { status: 'failed', error: outcome.error })
      if (outcome.conflicts?.length) updated.importConflicts = outcome.conflicts
      if (onRecovered) await onRecovered(updated, outcome)
      await saveJob(updated)
      await imports.discard(id)
      log(outcome.status === 'completed' ? `Recovery job ${id}: finished an import interrupted by a restart.` : `Recovery job ${id}: ${outcome.error}`)
    } catch (error) {
      unsettled.add(id)
      log(`Recovery job ${id}: the interrupted import could not be settled: ${errorMessage(error)}`)
    }
  }
  return unsettled
}

export function createJobRunner({ listJobs, advance, saveJob = null, imports = null, onRecovered = null, intervalMs = 10_000, maxIdleMs = 5 * 60_000, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  const active = new Set()
  const inFlight = new Map()
  // Jobs whose interrupted import could not be settled; they are retried each tick and never advanced meanwhile,
  // since advancing would start the import again over the files it already committed.
  let unsettled = new Set()
  let recovery = Promise.resolve()
  let timer = null
  let idleDelay = intervalMs
  let running = false

  async function recover(only = null) {
    if (!imports || !saveJob) return
    try {
      const remaining = await recoverInterruptedImports({ listJobs, saveJob, imports, onRecovered, log, only })
      unsettled = only ? new Set([...unsettled].filter((id) => remaining.has(id) || !only.has(id))) : remaining
    } catch (error) { log(`Interrupted imports could not be checked: ${errorMessage(error)}`) }
  }

  function schedule(delay) {
    if (!running) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => { timer = null; void tick() }, delay)
    timer?.unref?.()
  }

  async function rescan() {
    for (const job of await listJobs()) if (job?.id && !isTerminalJob(job) && !unsettled.has(String(job.id))) active.add(job.id)
  }

  function advanceOne(id) {
    if (inFlight.has(id)) return inFlight.get(id)
    const run = (async () => {
      try {
        const response = await advance(id)
        if (isTerminalJob(response?.job)) {
          active.delete(id)
          // The job is saved as completed or failed, so its import manifest is no longer needed.
          await imports?.discard(id).catch((error) => log(`Recovery job ${id}: its import manifest could not be removed: ${errorMessage(error)}`))
        }
      } catch (error) {
        // A cancelled job's state file is gone; anything else is retried on the next tick.
        if (error?.code === 'ENOENT') { active.delete(id); await imports?.discard(id).catch(() => {}) }
        else log(`Recovery job ${id} could not be advanced: ${errorMessage(error)}`)
      } finally { inFlight.delete(id) }
    })()
    inFlight.set(id, run)
    return run
  }

  async function tick() {
    await recovery
    if (unsettled.size) { recovery = recover(new Set(unsettled)); await recovery }
    // Nothing active: look for jobs on disk, polling less often the longer the agent stays idle.
    if (!active.size) {
      try { await rescan() } catch (error) { log(`Recovery jobs could not be listed: ${error instanceof Error ? error.message : 'unknown error'}`) }
    }
    if (!active.size) {
      idleDelay = Math.min(idleDelay * 2, maxIdleMs)
      schedule(idleDelay)
      return
    }
    idleDelay = intervalMs
    // A job still importing from an earlier tick is skipped, not awaited, so one long import never holds up the rest.
    const round = [...active].filter((id) => !inFlight.has(id)).map(advanceOne)
    schedule(intervalMs)
    await Promise.all(round)
  }

  return {
    async start() {
      running = true
      recovery = recover()
      await recovery
      try { await rescan() } catch (error) { log(`Recovery jobs could not be listed: ${error instanceof Error ? error.message : 'unknown error'}`) }
      schedule(0)
    },
    // A newly queued job is advanced on the next tick, which is brought forward to now.
    track(id) {
      active.add(String(id))
      idleDelay = intervalMs
      schedule(0)
    },
    // Stops advancing a job and waits for any advance already running, e.g. before a cancellation removes it.
    async forget(id) {
      active.delete(String(id))
      await inFlight.get(String(id))
    },
    async stop() {
      running = false
      if (timer) clearTimer(timer)
      timer = null
      await Promise.all(inFlight.values())
    },
    activeJobs: () => [...active],
    unsettledImports: () => [...unsettled],
  }
}
