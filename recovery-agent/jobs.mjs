// Advances recovery jobs on a timer so downloads and imports finish with no browser open. Each tick runs every
// active job through `advance` (the per-job locked poller in usenet-job.mjs), so a tick never imports a job twice.
const terminalStatuses = new Set(['completed', 'failed'])

export function isTerminalJob(job) {
  return terminalStatuses.has(job?.status)
}

export function jobPollIntervalMs(env = process.env) {
  const seconds = Number(env.TOMIFY_JOB_POLL_SECONDS)
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000
}

export function createJobRunner({ listJobs, advance, intervalMs = 10_000, maxIdleMs = 5 * 60_000, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  const active = new Set()
  const inFlight = new Map()
  let timer = null
  let idleDelay = intervalMs
  let running = false

  function schedule(delay) {
    if (!running) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => { timer = null; void tick() }, delay)
    timer?.unref?.()
  }

  async function rescan() {
    for (const job of await listJobs()) if (job?.id && !isTerminalJob(job)) active.add(job.id)
  }

  function advanceOne(id) {
    if (inFlight.has(id)) return inFlight.get(id)
    const run = (async () => {
      try {
        const response = await advance(id)
        if (isTerminalJob(response?.job)) active.delete(id)
      } catch (error) {
        // A cancelled job's state file is gone; anything else is retried on the next tick.
        if (error?.code === 'ENOENT') active.delete(id)
        else log(`Recovery job ${id} could not be advanced: ${error instanceof Error ? error.message : 'unknown error'}`)
      } finally { inFlight.delete(id) }
    })()
    inFlight.set(id, run)
    return run
  }

  async function tick() {
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
  }
}
