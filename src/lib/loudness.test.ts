import { describe, expect, it } from 'vitest'
import type { Track } from '../types'
import { gainModeAt, originalVolumeScale, queueIndexOf, streamGainMode } from './loudness'

const track = (id: string, albumId?: string, replayGain?: Track['replayGain']): Track => ({ id, title: id, artist: 'TMBG', album: albumId ?? '', albumId, replayGain })

describe('loudness normalisation', () => {
  const queue = [track('a', 'flood'), track('b', 'flood'), track('c', 'lincoln'), track('d')]

  it('uses album gain while an album plays in order and track gain otherwise', () => {
    expect(gainModeAt(queue, 0, 'auto')).toBe('album')
    expect(gainModeAt(queue, 1, 'auto')).toBe('album')
    expect(gainModeAt(queue, 2, 'auto')).toBe('track')
    expect(gainModeAt(queue, 3, 'auto')).toBe('track')
    expect(gainModeAt([track('a', 'flood'), track('a', 'flood')], 0, 'auto')).toBe('track')
  })

  it('follows a fixed setting and turns off', () => {
    expect(gainModeAt(queue, 2, 'album')).toBe('album')
    expect(gainModeAt(queue, 0, 'track')).toBe('track')
    expect(gainModeAt(queue, 0, 'off')).toBeNull()
  })

  it('finds a track at the current spot, the next one, or anywhere in the queue', () => {
    const repeated = [track('a'), track('b'), track('c'), track('a')]
    expect(queueIndexOf(repeated, 3, repeated[0])).toBe(3)
    expect(queueIndexOf(repeated, 2, repeated[0])).toBe(3)
    expect(queueIndexOf(repeated, 1, repeated[0])).toBe(0)
    expect(queueIndexOf(repeated, 0, track('z'))).toBe(-1)
  })

  it('only asks for a normalised stream when the track has a gain for it', () => {
    expect(streamGainMode(track('a', 'x', { trackGain: -6 }), 'album')).toBe('album')
    expect(streamGainMode(track('a'), 'track')).toBeNull()
    expect(streamGainMode(track('a', 'x', { trackGain: -6 }), null)).toBeNull()
  })

  it('turns original files down by their gain but never up', () => {
    expect(originalVolumeScale(track('a', 'x', { trackGain: -10.0206, trackPeak: 0.5 }), 'track')).toBeCloseTo(0.5)
    expect(originalVolumeScale(track('a', 'x', { trackGain: -20, albumGain: -14 }), 'album')).toBeCloseTo(0.316, 3)
    expect(originalVolumeScale(track('a', 'x', { trackGain: 5, trackPeak: 0.3 }), 'track')).toBe(1)
    expect(originalVolumeScale(track('a'), 'track')).toBe(1)
    expect(originalVolumeScale(track('a', 'x', { trackGain: -6 }), null)).toBe(1)
  })
})
