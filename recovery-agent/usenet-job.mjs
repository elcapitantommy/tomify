export function jobResponse(job) {
  if (job.status === 'completed') return { job: { id: job.id, status: 'completed', progress: 100, result: job.importResult } }
  if (job.status === 'failed') return { job: { id: job.id, status: 'failed', progress: job.progress || 0, error: job.error || job.message || null } }
  return { job: { id: job.id, status: job.status, progress: job.progress || 0, message: job.message || null, error: job.error || null, details: job.details || null, result: job.importResult || null } }
}

export function createUsenetJobPoller({ loadJob, saveJob, downloaderStatus, completeJob, sanitizeError, now = () => new Date().toISOString() }) {
  const activePolls = new Map()

  async function pollOnce(id) {
    const job = await loadJob(id)
    if (job.status === 'completed' || job.status === 'failed') return jobResponse(job)
    try {
      const state = await downloaderStatus(job.remoteId, job)
      job.status = state.status
      job.progress = state.progress || 0
      job.message = state.message || null
      // Downloaders that report live transfer figures (qBittorrent) pass them through for the Recovery page.
      job.details = state.details || null
      job.updatedAt = now()
      // Keep the downloader's own reason (e.g. missing articles, repair failed) as the job error.
      if (state.status === 'failed') job.error = sanitizeError(new Error(state.message || 'The downloader reported the download as failed.'))
      if (state.status === 'completed') {
        job.status = 'importing'
        await saveJob(job)
        job.importResult = await completeJob(job, state)
        job.status = 'completed'
        job.progress = 100
      }
    } catch (error) {
      job.status = 'failed'
      job.error = sanitizeError(error)
    }
    await saveJob(job)
    return jobResponse(job)
  }

  async function pollUsenetJob(id) {
    const key = String(id || '')
    const active = activePolls.get(key)
    if (active) return active
    const poll = pollOnce(id)
    activePolls.set(key, poll)
    try { return await poll }
    finally { if (activePolls.get(key) === poll) activePolls.delete(key) }
  }
  // The stored job as it stands, for status requests: never asks the downloader or starts an import.
  pollUsenetJob.read = async (id) => jobResponse(await loadJob(id))
  // Lets a cancellation wait for a poll (and any import it started) to finish first.
  pollUsenetJob.settled = async (id) => { await activePolls.get(String(id || ''))?.catch(() => {}) }
  return pollUsenetJob
}
