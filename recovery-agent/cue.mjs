// Splits whole-disc audio images (one FLAC or WAV per CD plus a .cue sheet) into one FLAC per track, so a
// discography ripped as disc images imports as albums of tracks instead of one 60-minute "track" per CD.
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { decodeToolOutput } from './text-encoding.mjs'

const IMAGE_EXTENSIONS = new Set(['.flac', '.wav'])
const MAX_CUE_BYTES = 256 * 1024
const MAX_TRACKS = 99

function unquote(value) {
  const text = String(value || '').trim()
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
}

// mm:ss:ff, where ff is a CD frame (1/75 s). Minutes may exceed 59.
export function cueTimeSeconds(value) {
  const match = /^(\d{1,3}):([0-5]\d):([0-7]\d)$/.exec(String(value || '').trim())
  if (!match || Number(match[3]) > 74) return null
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 75
}

/** Parses a cue sheet. Returns null unless it describes exactly one audio file holding two or more tracks. */
export function parseCueSheet(text) {
  const sheet = { performer: '', title: '', date: '', genre: '', discNumber: null, totalDiscs: null, file: null, tracks: [] }
  let files = 0
  let track = null
  for (const rawLine of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const [keyword = '', ...rest] = line.split(/\s+/)
    const value = line.slice(keyword.length).trim()
    switch (keyword.toUpperCase()) {
      case 'REM': {
        const [field = '', ...remRest] = rest
        const remValue = unquote(remRest.join(' '))
        const name = field.toUpperCase()
        if (name === 'DATE') sheet.date = remValue
        else if (name === 'GENRE') sheet.genre = remValue
        else if (name === 'DISCNUMBER' && /^\d{1,2}$/.test(remValue)) sheet.discNumber = Number(remValue)
        else if (name === 'TOTALDISCS' && /^\d{1,2}$/.test(remValue)) sheet.totalDiscs = Number(remValue)
        break
      }
      case 'FILE': {
        files += 1
        const match = /^"(.*)"(?:\s+\S+)?$|^(\S+)(?:\s+\S+)?$/.exec(value)
        sheet.file = match ? (match[1] ?? match[2]) : null
        break
      }
      case 'TRACK':
        if (!/^\d{1,2}$/.test(rest[0] || '') || (rest[1] || '').toUpperCase() !== 'AUDIO') { track = null; break }
        track = { number: Number(rest[0]), title: '', performer: '', start: null }
        sheet.tracks.push(track)
        break
      case 'TITLE': if (track) track.title = unquote(value); else sheet.title = unquote(value); break
      case 'PERFORMER': if (track) track.performer = unquote(value); else sheet.performer = unquote(value); break
      case 'INDEX':
        if (track && rest[0] === '01') track.start = cueTimeSeconds(rest[1])
        break
      default: break
    }
  }
  if (files !== 1 || !sheet.file || sheet.tracks.length < 2 || sheet.tracks.length > MAX_TRACKS) return null
  for (let index = 0; index < sheet.tracks.length; index += 1) {
    const current = sheet.tracks[index]
    if (current.start === null) return null
    if (index > 0 && current.start <= sheet.tracks[index - 1].start) return null
  }
  return sheet
}

const DISC_MARKER = /\s*[([]?\s*(?:-\s*)?(?:CD|Disc|Disk)\s*(\d{1,2})\s*[)\]]?\s*$/i

/** The album title without a trailing "(CD1)" / "[Disc 2]" / "CD 1" marker, and the disc number it named. */
export function splitDiscMarker(title) {
  const match = DISC_MARKER.exec(String(title || ''))
  if (!match) return { title: String(title || '').trim(), disc: null }
  return { title: String(title).slice(0, match.index).trim(), disc: Number(match[1]) }
}

function discFromName(name) {
  const match = /(?:^|[^a-z])(?:CD|Disc|Disk)\s*(\d{1,2})(?![0-9])/i.exec(String(name || ''))
  return match ? Number(match[1]) : null
}

function safeFileName(value) {
  return String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Track'
}

/** The audio file a cue sheet points at, among the audio files in its folder. */
export function matchCueImage(cuePath, sheet, audioFiles) {
  const folder = dirname(cuePath)
  const inFolder = audioFiles.filter((file) => dirname(file.path) === folder && IMAGE_EXTENSIONS.has(extname(file.path).toLowerCase()))
  const named = basename(String(sheet.file || '').replace(/\\/g, '/'))
  const exact = inFolder.find((file) => file.name === named)
  if (exact) return exact
  // Rippers often name "Album.wav" in the cue sheet and the file is later converted to FLAC.
  const stem = (name) => name.slice(0, name.length - extname(name).length).toLowerCase()
  const sameStem = inFolder.filter((file) => stem(file.name) === stem(named))
  if (sameStem.length === 1) return sameStem[0]
  const cueStem = stem(basename(cuePath))
  const byCueName = inFolder.filter((file) => stem(file.name) === cueStem)
  if (byCueName.length === 1) return byCueName[0]
  return null
}

/** The ffmpeg arguments and output name for each track of an image. */
export function cueTrackPlans(sheet, image, cuePath, outputDirectory) {
  const { title: albumTitle, disc: titleDisc } = splitDiscMarker(sheet.title)
  const disc = sheet.discNumber ?? titleDisc ?? discFromName(basename(cuePath)) ?? discFromName(image.name) ?? discFromName(basename(dirname(cuePath)))
  const total = sheet.tracks.length
  return sheet.tracks.map((track, index) => {
    const next = sheet.tracks[index + 1]
    const number = String(track.number).padStart(2, '0')
    const output = join(outputDirectory, `${number} - ${safeFileName(track.title || `Track ${number}`)}.flac`)
    const artist = track.performer || sheet.performer
    const metadata = {
      TITLE: track.title || `Track ${number}`, ARTIST: artist, ALBUM: albumTitle, ALBUMARTIST: sheet.performer || artist,
      TRACKNUMBER: String(track.number), TRACKTOTAL: String(total), DISCNUMBER: disc ? String(disc) : '',
      DISCTOTAL: sheet.totalDiscs ? String(sheet.totalDiscs) : '', DATE: sheet.date, GENRE: sheet.genre, CUESHEET: '',
    }
    const args = ['-v', 'error', '-nostdin', '-y', '-ss', track.start.toFixed(6), '-i', image.path]
    if (next) args.push('-t', (next.start - track.start).toFixed(6))
    args.push('-map', '0:a:0', '-map_metadata', '0', '-c:a', 'flac')
    for (const [key, value] of Object.entries(metadata)) if (value || key === 'CUESHEET') args.push('-metadata', `${key}=${value}`)
    args.push(output)
    return { output, args }
  })
}

async function cueSheetsBeside(audioFiles) {
  const cues = []
  for (const folder of new Set(audioFiles.map((file) => dirname(file.path)))) {
    let entries
    try { entries = await readdir(folder) } catch { continue }
    for (const entry of entries.sort()) {
      if (extname(entry).toLowerCase() !== '.cue') continue
      const path = join(folder, entry)
      const details = await lstat(path).catch(() => null)
      if (details?.isFile() && details.size <= MAX_CUE_BYTES) cues.push(path)
    }
  }
  return cues
}

/**
 * Replaces each disc image that has a cue sheet with its split tracks, written under `destination`.
 * Images without a usable cue sheet, or whose split fails, are kept as they are.
 */
export async function expandCueImages(audioFiles, { destination, run, ffmpeg = 'ffmpeg', log = () => {} }) {
  const replaced = new Map()
  let folderIndex = 0
  for (const cuePath of await cueSheetsBeside(audioFiles)) {
    let sheet
    try { sheet = parseCueSheet(decodeToolOutput(await readFile(cuePath))) } catch { sheet = null }
    if (!sheet) continue
    const image = matchCueImage(cuePath, sheet, audioFiles)
    if (!image || replaced.has(image.path)) continue
    folderIndex += 1
    const outputDirectory = join(destination, `cue-${String(folderIndex).padStart(3, '0')}`, safeFileName(basename(dirname(image.path))))
    try {
      await mkdir(outputDirectory, { recursive: true })
      const tracks = []
      for (const plan of cueTrackPlans(sheet, image, cuePath, outputDirectory)) {
        await run(ffmpeg, plan.args, 10 * 60_000)
        const details = await lstat(plan.output)
        tracks.push({ path: plan.output, size: details.size, name: basename(plan.output) })
      }
      replaced.set(image.path, tracks)
    } catch (error) {
      log(`Could not split ${image.name} using ${basename(cuePath)}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }
  return audioFiles.flatMap((file) => replaced.get(file.path) || [file])
}
