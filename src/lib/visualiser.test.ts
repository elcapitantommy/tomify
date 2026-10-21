import { describe, expect, it } from 'vitest'
import { barHeights, nextVisualiserMode, wavePoints } from './visualiser'

describe('visualiser maths', () => {
  it('cycles Off, Bars, Wave', () => {
    expect(nextVisualiserMode('off')).toBe('bars')
    expect(nextVisualiserMode('bars')).toBe('wave')
    expect(nextVisualiserMode('wave')).toBe('off')
  })

  it('folds the spectrum into bars from 0 to 1, with the bass on the left', () => {
    const spectrum = new Uint8Array(1024)
    spectrum.fill(255, 0, 4)
    const heights = barHeights(spectrum, 32)
    expect(heights).toHaveLength(32)
    expect(heights[0]).toBe(1)
    expect(heights.at(-1)).toBe(0)
    expect(heights.every((value) => value >= 0 && value <= 1)).toBe(true)
    expect(barHeights(new Uint8Array(1024).fill(128), 48).every((value) => value === 128 / 255)).toBe(true)
  })

  it('thins the wave to points from -1 to 1, flat for silence', () => {
    const silence = wavePoints(new Uint8Array(2048).fill(128), 100)
    expect(silence).toHaveLength(100)
    expect(silence.every((value) => value === 0)).toBe(true)
    const wave = wavePoints(Uint8Array.from([0, 128, 255]), 3)
    expect(wave[0]).toBe(-1)
    expect(wave[1]).toBe(0)
    expect(wave[2]).toBeCloseTo(0.99, 2)
    expect(wavePoints(new Uint8Array(0), 10)).toEqual([])
  })
})
