function jobResponse(job) {
  if (job.status === 'completed') return { job: { id: job.id, status: 'completed', progress: 100, result: job.importResult } }
  if (job.status === 'failed') return { job: { id: job.id, status: 'failed', progress: job.progress || 0, error: job.error } }
  return { job: { id: job.id, status: job.status, progress: job.progress || 0, message: job.message || null, error: job.error || null, result: job.importResult || null } }
}

export function createUsenetJobPoller({ loadJob, saveJob, downloaderStatus, completeJob, sanitizeError, now = () => new Date().toISOString() }) {
  const activePolls = new Map()

  async function pollOnce(id) {
    const job = await loadJob(id)
    if (job.status === 'completed' || job.status === 'failed') return jobResponse(job)
    try {
      const state = await downloaderStatus(job.remoteId)
      job.status = state.status
      job.progress = state.progress || 0
      job.message = state.message || null
      job.updatedAt = now()
      if (state.status === 'completed') {
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

  return async function pollUsenetJob(id) {
    const key = String(id || '')
    const active = activePolls.get(key)
    if (active) return active
    const poll = pollOnce(id)
    activePolls.set(key, poll)
    try { return await poll }
    finally { if (activePolls.get(key) === poll) activePolls.delete(key) }
  }
}
