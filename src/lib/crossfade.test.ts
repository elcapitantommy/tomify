import { describe, expect, it } from 'vitest'
import { crossfadeSeconds, fadeInLevel, fadeOutLevel } from './crossfade'

const song = (id: string, albumId?: string, duration = 200) => ({ id, title: id, artist: 'A', album: 'B', albumId, duration })
const options = { canFade: true, dj: false }

describe('crossfade', () => {
  it('fades between songs from different albums by the setting, never past half a song', () => {
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'y'), 6, options)).toBe(6)
    expect(crossfadeSeconds(song('a'), song('b'), 6, options)).toBe(6)
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'y', 8), 6, options)).toBe(4)
  })

  it('stays gapless when off, on the same album, in a DJ set or where volume cannot fade', () => {
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'y'), 0, options)).toBe(0)
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'x'), 6, options)).toBe(0)
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'y'), 6, { canFade: true, dj: true })).toBe(0)
    expect(crossfadeSeconds(song('a', 'x'), song('b', 'y'), 6, { canFade: false, dj: false })).toBe(0)
  })

  it('keeps the combined power steady through the fade', () => {
    for (const progress of [0, 0.25, 0.5, 0.9, 1]) expect(fadeOutLevel(progress) ** 2 + fadeInLevel(progress) ** 2).toBeCloseTo(1)
    expect(fadeOutLevel(0)).toBe(1)
    expect(fadeInLevel(1)).toBe(1)
  })
})
