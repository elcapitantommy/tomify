// ReplayGain tagging for imports. Navidrome hands ReplayGain tags to the player but never measures loudness
// itself, so the agent runs rsgain over each import's staged derivatives before the import manifest records
// their sha256: the files that reach the library are already tagged, and a resumed or rolled-back import still
// finds exactly the files it recorded. Preserved originals are never touched. Tagging is best effort: a missing
// rsgain or a file it can't read is logged and the import carries on untagged.
import { spawn as nodeSpawn } from 'node:child_process'
import { dirname, extname, resolve, sep } from 'node:path'

// What rsgain can tag (TagLib formats).
export const LOUDNESS_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.alac', '.ogg', '.oga', '.opus', '.spx', '.wav', '.aif', '.aiff', '.wv', '.ape', '.wma', '.mpc'])

function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }

// Staged derivatives grouped by the album folder they will land in, so album gain covers the whole album this
// import brings. Only files inside the import's staging directory qualify.
export function loudnessAlbums(entries, stagingRoot) {
  const root = resolve(stagingRoot)
  const albums = new Map()
  for (const entry of entries) {
    if (entry.role !== 'derivative' || !inside(resolve(entry.source), root)) continue
    if (!LOUDNESS_EXTENSIONS.has(extname(entry.destination).toLowerCase())) continue
    const album = dirname(resolve(entry.destination))
    albums.set(album, [...(albums.get(album) ?? []), entry.source])
  }
  return [...albums.values()]
}

// ReplayGain 2.0 (EBU R128, -18 LUFS): track and album gain and peak, written as REPLAYGAIN_* tags.
export function rsgainArguments(files) {
  return ['custom', '-a', '-s', 'i', '-q', ...files]
}

function runCommand(spawn, command, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim().split('\n').pop() || (signal ? `killed by ${signal}` : `exit ${code}`)))
    })
  })
}

// Turned on by RSGAIN_PATH. Returns { tagged, failed } file counts and never throws.
export function createLoudnessTagger({ rsgain = process.env.RSGAIN_PATH || '', spawn = nodeSpawn, log = (message) => process.stderr.write(`${message}\n`), timeoutMs = 10 * 60_000 } = {}) {
  let missing = false
  return async function tagLoudness(entries, stagingRoot) {
    const albums = loudnessAlbums(entries, stagingRoot)
    const outcome = { tagged: 0, failed: 0 }
    if (!rsgain || missing || !albums.length) return outcome
    for (const files of albums) {
      try {
        await runCommand(spawn, rsgain, rsgainArguments(files), timeoutMs)
        outcome.tagged += files.length
      } catch (error) {
        outcome.failed += files.length
        if (error?.code === 'ENOENT') {
          missing = true
          log(`ReplayGain tagging is off: ${rsgain} was not found.`)
          break
        }
        log(`ReplayGain tagging failed for ${files.length} file${files.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return outcome
  }
}

let defaultTagger = null
export function defaultLoudnessTagger() {
  defaultTagger ??= createLoudnessTagger()
  return defaultTagger
}
