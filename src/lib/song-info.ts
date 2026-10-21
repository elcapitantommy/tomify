import type { Track } from '../types'
import { formatBytes, formatDuration } from './format'

// Suffixes that are always lossless. M4A can be ALAC or AAC, so it counts only when Navidrome reports a bit depth.
const LOSSLESS = new Set(['flac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'alac', 'dsf', 'dff', 'tta'])

export function isLossless(track: Pick<Track, 'suffix' | 'bitDepth'>) {
  const suffix = track.suffix?.toLowerCase()
  if (!suffix) return false
  return LOSSLESS.has(suffix) || (suffix === 'm4a' && Boolean(track.bitDepth))
}

// Hi-Res means lossless at more than CD quality (16-bit / 44.1 or 48 kHz).
export function isHiRes(track: Pick<Track, 'suffix' | 'bitDepth' | 'samplingRate'>) {
  return isLossless(track) && ((track.bitDepth ?? 0) > 16 || (track.samplingRate ?? 0) > 48_000)
}

export const formatRate = (hz: number) => `${Number((hz / 1000).toFixed(1))} kHz`

// "FLAC · 24-bit / 96 kHz" or "MP3 · 320 kbps".
export function qualityLabel(track: Pick<Track, 'suffix' | 'bitDepth' | 'samplingRate' | 'bitRate'>) {
  const format = track.suffix?.toUpperCase() || 'Unknown format'
  if (isLossless(track)) {
    const parts = [track.bitDepth ? `${track.bitDepth}-bit` : null, track.samplingRate ? formatRate(track.samplingRate) : null].filter(Boolean)
    return parts.length ? `${format} · ${parts.join(' / ')}` : format
  }
  return track.bitRate ? `${format} · ${track.bitRate} kbps` : format
}

export interface AlbumQuality { label: string; detail: string; hiRes: boolean }

// One badge for a set of songs: Hi-Res or the lossless format when every song has it, otherwise nothing.
export function albumQuality(tracks: Track[]): AlbumQuality | null {
  if (!tracks.length || !tracks.every((track) => isLossless(track))) return null
  const formats = [...new Set(tracks.map((track) => track.suffix!.toUpperCase()))]
  const format = formats.length === 1 ? formats[0] : 'Lossless'
  const depth = Math.max(...tracks.map((track) => track.bitDepth ?? 0))
  const rate = Math.max(...tracks.map((track) => track.samplingRate ?? 0))
  const detail = [depth ? `${depth}-bit` : null, rate ? formatRate(rate) : null].filter(Boolean).join(' / ')
  if (tracks.every((track) => isHiRes(track))) return { label: 'Hi-Res', detail: detail ? `${format} · ${detail}` : format, hiRes: true }
  return { label: format, detail: detail || 'Lossless', hiRes: false }
}

const channels = (count?: number) => count === 1 ? 'Mono' : count === 2 ? 'Stereo' : count ? `${count} channels` : null

// The rows Song info shows, leaving out anything the server didn't send.
export function songDetails(track: Track): Array<[string, string]> {
  const gain = track.replayGain?.trackGain
  const rows: Array<[string, string | null | undefined]> = [
    ['Format', track.suffix?.toUpperCase()],
    ['Quality', isLossless(track) ? [track.bitDepth ? `${track.bitDepth}-bit` : null, track.samplingRate ? formatRate(track.samplingRate) : null].filter(Boolean).join(' / ') || 'Lossless' : track.samplingRate ? formatRate(track.samplingRate) : null],
    ['Bitrate', track.bitRate ? `${track.bitRate} kbps` : null],
    ['Channels', channels(track.channelCount)],
    ['Length', track.duration ? formatDuration(track.duration) : null],
    ['File size', track.size ? formatBytes(track.size) : null],
    ['Album', track.album],
    ['Track', track.track ? (track.discNumber && track.discNumber > 1 ? `Disc ${track.discNumber}, track ${track.track}` : String(track.track)) : null],
    ['Year', track.year ? String(track.year) : null],
    ['Genre', track.genres?.length ? track.genres.map((genre) => genre.name).join(', ') : track.genre],
    ['BPM', track.bpm ? String(track.bpm) : null],
    ['Plays', typeof track.playCount === 'number' ? String(track.playCount) : null],
    ['Last played', track.played ? new Date(track.played).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null],
    ['Added', track.created ? new Date(track.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null],
    ['ReplayGain', typeof gain === 'number' ? `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB` : null],
    ['Comment', track.comment],
    ['File', track.path],
  ]
  for (const role of ['composer', 'producer', 'lyricist', 'conductor', 'arranger']) {
    const names = track.contributors?.filter((item) => item.role === role).map((item) => item.artist.name)
    if (names?.length) rows.splice(8, 0, [role[0].toUpperCase() + role.slice(1), [...new Set(names)].join(', ')])
  }
  return rows.filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].trim() !== '')
}
