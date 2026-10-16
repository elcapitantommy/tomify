import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { classifyQuality } from '../shared/quality.mjs'
import { foldName } from './text-encoding.mjs'

// Duplicate preflight (task 13): what the recovery library already holds in the release directory an acquisition
// would import into. Everything here is read-only: unlike resolveReleaseDirectory, nothing is ever created.

const audioExtensions = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.mka', '.wma', '.webm'])

function text(value) { return String(value ?? '').trim() }
function inside(child, parent) { return child === parent || child.startsWith(parent + sep) }
// The same cleaning as usenet-import.mjs uses for directory names, so preflight looks where an import would land.
function safeName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 120)
  return cleaned || fallback
}
function positiveNumber(value) {
  const match = text(value).match(/^\s*(\d{1,4})(?:\s*\/\s*\d+)?/)
  const parsed = match ? Number(match[1]) : null
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
function normalisedTags(tags) {
  const normalized = {}
  for (const [key, value] of Object.entries(tags || {})) {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (name && text(value) && normalized[name] === undefined) normalized[name] = text(value)
  }
  return normalized
}

/** The MusicBrainz recording id in a probe's tags (MUSICBRAINZ_TRACKID in Vorbis comments, "MusicBrainz Track Id" in ID3). */
export function taggedRecordingId(quality) {
  const tags = normalisedTags(quality?.tags)
  return tags.musicbrainztrackid || tags.musicbrainzrecordingid || null
}

async function matchingDirectory(parent, requested, fallback) {
  const name = safeName(requested, fallback).normalize('NFC')
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []; throw error })
  const directories = entries.filter((entry) => entry.isDirectory() && foldName(entry.name.normalize('NFC')) === foldName(name)).map((entry) => entry.name)
  const exact = directories.find((directory) => directory.normalize('NFC') === name)
  const selected = exact || directories.sort((left, right) => left.localeCompare(right, 'en'))[0]
  return selected ? resolve(parent, selected) : null
}

/** The existing release directory resolveReleaseDirectory would choose (case and Unicode insensitive), or null when there is none yet. */
export async function findReleaseDirectory(recoveryRoot, artist, album) {
  const root = await realpath(resolve(recoveryRoot)).catch(() => null)
  if (!root) return null
  const artistDirectory = await matchingDirectory(root, artist, 'Unknown Artist')
  const albumDirectory = artistDirectory && await matchingDirectory(artistDirectory, album, 'Recovered Tracks')
  if (!albumDirectory) return null
  const canonical = await realpath(albumDirectory)
  return inside(canonical, root) ? canonical : null
}

function filenameTrack(name) {
  const stem = basename(name, extname(name)).trim()
  const match = stem.match(/^(?:(\d{1,2})-)?(\d{1,3})\s*[-_. ]+\s*(.+)$/)
  return match ? { title: match[3].trim(), trackNumber: Number(match[2]), discNumber: match[1] ? Number(match[1]) : null } : { title: stem, trackNumber: null, discNumber: null }
}

async function readSidecar(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

/**
 * The audio files in a release directory with their track number, title, recording id and quality tier. A Tomify
 * sidecar is read first; it records the tags Tomify wrote, so only files without one are probed for their tags.
 */
export async function listExistingTracks(directory, { probe = null } = {}) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error?.code === 'ENOENT') return []; throw error })
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
  const audio = [...names].filter((name) => audioExtensions.has(extname(name).toLowerCase())).sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }))
  const tracks = []
  for (const name of audio) {
    const path = join(directory, name)
    const fromName = filenameTrack(name)
    const sidecar = names.has(`${name}.tomify.json`) ? await readSidecar(join(directory, `${name}.tomify.json`)) : null
    if (sidecar) {
      const metadata = sidecar.resolvedMetadata || {}
      const quality = sidecar.sourceAudio?.quality || sidecar.derivative?.quality || null
      tracks.push({ file: name, path, title: text(metadata.title) || fromName.title, trackNumber: positiveNumber(metadata.trackNumber) || fromName.trackNumber, discNumber: positiveNumber(metadata.discNumber) || fromName.discNumber, recordingId: text(metadata.recordingId) || null, tier: classifyQuality(quality).tier, source: 'sidecar' })
      continue
    }
    const quality = probe ? await probe(path).catch(() => null) : null
    const tags = normalisedTags(quality?.tags)
    tracks.push({ file: name, path, title: tags.title || fromName.title, trackNumber: positiveNumber(tags.tracknumber || tags.track) || fromName.trackNumber, discNumber: positiveNumber(tags.discnumber || tags.disc) || fromName.discNumber, recordingId: taggedRecordingId(quality), tier: classifyQuality(quality).tier, source: quality ? 'tags' : 'filename' })
  }
  return tracks
}

/** `POST /v1/preflight`: the release directory an acquisition of `{ artist, album, title, mode }` would use and the tracks already in it. */
export async function preflightRelease(recoveryRoot, input, { probe = null } = {}) {
  const directory = await findReleaseDirectory(recoveryRoot, text(input?.artist), text(input?.album))
  return { directory, mode: input?.mode === 'release' ? 'release' : 'track', existing: directory ? await listExistingTracks(directory, { probe }) : [] }
}

// Titles compared for skipExisting ignore case, accents, punctuation, spacing and "&" versus "and".
function titleKey(value) { return foldName(value).replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }

/**
 * skipExisting for release imports: a test for whether a track to import is already in the destination, by MusicBrainz
 * recording id or by normalised title plus track number.
 */
export async function existingTrackMatcher(directory, { probe = null } = {}) {
  const existing = await listExistingTracks(directory, { probe })
  const recordingIds = new Set(existing.map((track) => text(track.recordingId).toLowerCase()).filter(Boolean))
  const keys = new Set(existing.filter((track) => titleKey(track.title)).map((track) => `${track.trackNumber || 0}:${titleKey(track.title)}`))
  return (metadata, quality) => {
    const recordingId = text(metadata?.recordingId || taggedRecordingId(quality)).toLowerCase()
    if (recordingId && recordingIds.has(recordingId)) return true
    const title = titleKey(metadata?.title)
    return Boolean(title) && keys.has(`${positiveNumber(metadata?.trackNumber) || 0}:${title}`)
  }
}
