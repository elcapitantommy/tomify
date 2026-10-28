// A small, bounded disk cache of audio files.
//
// When the phone switches to audio, it asks TomTube to fetch that video's AAC audio (and the next
// queued track's) to disk in the background. Once a file is complete, audio is served from here, so a
// locked phone keeps playing even if YouTube's address expires or YouTube is slow. Only audio is
// cached (a few MB per song); video always streams straight through.
//
// Limits: total bytes (oldest-used files go first), age, and a per-file maximum. Partial downloads are
// `.part` files that are never served and are removed at start-up and by every sweep.
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { isVideoId } from './ids.mjs'

const NAME = /^([A-Za-z0-9_-]{11})\.(\d{1,4})\.m4a$/
const PART = /\.part$/

export function createAudioCache({ dir, maxBytes, maxAgeMs, maxFileBytes, partMaxAgeMs = 3600_000, now = Date.now, log = () => {} }) {
  const filling = new Map()

  function pathFor(videoId, itag) {
    if (!isVideoId(videoId) || !/^\d{1,4}$/.test(String(itag))) throw new TypeError('Invalid cache key.')
    return join(dir, `${videoId}.${itag}.m4a`)
  }

  async function lookup(videoId, itag) {
    const path = pathFor(videoId, itag)
    try {
      const details = await stat(path)
      if (now() - details.mtimeMs > maxAgeMs) return null
      const at = new Date(now())
      await utimes(path, at, at).catch(() => undefined)
      return { path, size: details.size }
    } catch { return null }
  }

  // Writes the chunks from `source` (an async iterable of Buffers) to the cache. Concurrent fills of
  // the same file share one download. Refuses files over the per-file limit.
  async function fill(videoId, itag, size, source) {
    const key = `${videoId}.${itag}`
    if (filling.has(key)) return filling.get(key)
    if (!(size > 0) || size > maxFileBytes) return null
    const task = (async () => {
      await mkdir(dir, { recursive: true })
      const final = pathFor(videoId, itag)
      const part = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.part`
      const out = createWriteStream(part, { flags: 'wx', mode: 0o600 })
      let written = 0
      try {
        for await (const chunk of source()) {
          written += chunk.length
          if (written > size) throw new Error('more data than expected')
          if (!out.write(chunk)) await once(out, 'drain')
        }
        out.end()
        await once(out, 'finish')
        if (written !== size) throw new Error(`incomplete (${written} of ${size} bytes)`)
        await rename(part, final)
        await sweep()
        return { path: final, size }
      } catch (error) {
        out.destroy()
        await rm(part, { force: true })
        log(`Audio cache fill for ${videoId} failed: ${error instanceof Error ? error.message : error}`)
        return null
      }
    })().finally(() => filling.delete(key))
    filling.set(key, task)
    return task
  }

  // Removes stale partial files, expired files, then the least recently used until under the limit.
  async function sweep({ startup = false } = {}) {
    let names
    try { names = await readdir(dir) } catch { return { removed: 0, bytes: 0, files: 0 } }
    const files = []
    let removed = 0
    for (const name of names) {
      const path = join(dir, name)
      let details
      try { details = await stat(path) } catch { continue }
      if (!details.isFile()) continue
      if (PART.test(name)) {
        // A part being written right now is left alone, except at start-up when none can be.
        if (startup || now() - details.mtimeMs > partMaxAgeMs) { await rm(path, { force: true }); removed += 1 }
        continue
      }
      if (!NAME.test(name) || now() - details.mtimeMs > maxAgeMs) { await rm(path, { force: true }); removed += 1; continue }
      files.push({ path, size: details.size, used: details.mtimeMs })
    }
    files.sort((a, b) => a.used - b.used)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    while (total > maxBytes && files.length) {
      const oldest = files.shift()
      await rm(oldest.path, { force: true })
      total -= oldest.size
      removed += 1
    }
    return { removed, bytes: total, files: files.length }
  }

  async function stats() {
    const result = await sweep()
    return { ...result, maxBytes, filling: filling.size }
  }

  return { dir, pathFor, lookup, fill, sweep, stats, isFilling: (videoId, itag) => filling.has(`${videoId}.${itag}`) }
}
