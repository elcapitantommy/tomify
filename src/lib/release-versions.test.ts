import { describe, expect, it } from 'vitest'
import type { Album, Track } from '../types'
import { versionLabels } from './release-versions'

const track = (id: string, suffix = 'flac'): Track => ({ id, title: id, artist: 'Aerosmith', album: 'Permanent Vacation', suffix })
const version = (id: string, name: string, extra: Partial<Album> = {}, tracks: Track[] = [track(`${id}-1`)]): Album & { song: Track[] } => ({ id, name, artist: 'Aerosmith', ...extra, song: tracks })

describe('versionLabels', () => {
  it('uses the album name alone when the names already differ', () => {
    const labels = versionLabels([version('a', 'Flood'), version('b', 'Flood (Japan Edition)')])
    expect(labels.get('a')).toBe('Flood')
    expect(labels.get('b')).toBe('Flood (Japan Edition)')
  })

  it('adds year, format and song count until same-named versions can be told apart', () => {
    const labels = versionLabels([
      version('a', 'Permanent Vacation', { year: 1987 }),
      version('b', 'Permanent Vacation', { year: 1993 }),
      version('c', 'Permanent Vacation', { year: 1993 }, [track('c-1', 'mp3')]),
      version('d', 'Permanent Vacation', { year: 1993 }, [track('d-1'), track('d-2')]),
    ])
    expect(labels.get('a')).toBe('Permanent Vacation · 1987')
    expect(labels.get('b')).toBe('Permanent Vacation · 1993 · FLAC · 1 song')
    expect(labels.get('c')).toBe('Permanent Vacation · 1993 · MP3')
    expect(labels.get('d')).toBe('Permanent Vacation · 1993 · FLAC · 2 songs')
  })

  it('numbers versions that match on every detail', () => {
    const labels = versionLabels([version('a', 'Pump', { year: 1989 }), version('b', 'Pump', { year: 1989 })])
    expect(labels.get('a')).toBe('Pump · 1989 · FLAC · 1 song (1)')
    expect(labels.get('b')).toBe('Pump · 1989 · FLAC · 1 song (2)')
  })
})
