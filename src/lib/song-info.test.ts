import { describe, expect, it } from 'vitest'
import { albumQuality, isHiRes, isLossless, qualityLabel, songDetails } from './song-info'
import type { Track } from '../types'

const base: Track = { id: 't1', title: 'Song', artist: 'Artist', album: 'Album' }

describe('song quality', () => {
  it('tells lossless and Hi-Res files apart', () => {
    expect(isLossless({ suffix: 'flac' })).toBe(true)
    expect(isLossless({ suffix: 'mp3' })).toBe(false)
    expect(isLossless({ suffix: 'm4a' })).toBe(false)
    expect(isLossless({ suffix: 'm4a', bitDepth: 16 })).toBe(true)
    expect(isHiRes({ suffix: 'flac', bitDepth: 16, samplingRate: 44100 })).toBe(false)
    expect(isHiRes({ suffix: 'flac', bitDepth: 24, samplingRate: 96000 })).toBe(true)
    expect(isHiRes({ suffix: 'flac', bitDepth: 16, samplingRate: 88200 })).toBe(true)
    expect(isHiRes({ suffix: 'mp3', bitDepth: 24, samplingRate: 96000 })).toBe(false)
  })

  it('describes the quality in one line', () => {
    expect(qualityLabel({ suffix: 'flac', bitDepth: 24, samplingRate: 96000 })).toBe('FLAC · 24-bit / 96 kHz')
    expect(qualityLabel({ suffix: 'flac', bitDepth: 16, samplingRate: 44100 })).toBe('FLAC · 16-bit / 44.1 kHz')
    expect(qualityLabel({ suffix: 'mp3', bitRate: 320 })).toBe('MP3 · 320 kbps')
    expect(qualityLabel({})).toBe('Unknown format')
  })

  it('badges an album only when every song is lossless', () => {
    const flac = { ...base, suffix: 'flac', bitDepth: 16, samplingRate: 44100 }
    const hiRes = { ...base, suffix: 'flac', bitDepth: 24, samplingRate: 96000 }
    expect(albumQuality([flac, flac])).toEqual({ label: 'FLAC', detail: '16-bit / 44.1 kHz', hiRes: false })
    expect(albumQuality([hiRes, hiRes])).toEqual({ label: 'Hi-Res', detail: 'FLAC · 24-bit / 96 kHz', hiRes: true })
    expect(albumQuality([hiRes, flac])?.label).toBe('FLAC')
    expect(albumQuality([flac, { ...base, suffix: 'wav', bitDepth: 16 }])?.label).toBe('Lossless')
    expect(albumQuality([flac, { ...base, suffix: 'mp3', bitRate: 320 }])).toBeNull()
    expect(albumQuality([])).toBeNull()
  })
})

describe('song details', () => {
  it('lists what the server sent and leaves out the rest', () => {
    const rows = Object.fromEntries(songDetails({ ...base, suffix: 'flac', bitDepth: 24, samplingRate: 48000, bitRate: 2304, channelCount: 2, size: 52_428_800, duration: 245, track: 3, discNumber: 2, playCount: 7, bpm: 120, path: 'Artist/Album/03 Song.flac', replayGain: { trackGain: -6.25 }, contributors: [{ role: 'composer', artist: { id: 'c1', name: 'Writer' } }] }))
    expect(rows).toMatchObject({ Format: 'FLAC', Quality: '24-bit / 48 kHz', Bitrate: '2304 kbps', Channels: 'Stereo', Length: '4:05', 'File size': '50 MB', Track: 'Disc 2, track 3', Plays: '7', BPM: '120', ReplayGain: '-6.3 dB', Composer: 'Writer', File: 'Artist/Album/03 Song.flac' })
    expect(rows).not.toHaveProperty('Genre')
    expect(rows).not.toHaveProperty('Comment')
  })
})
