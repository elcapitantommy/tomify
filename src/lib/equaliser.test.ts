import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAudioContext } from '../test/fakeAudioContext'
import { EQ_BANDS, EqualiserGraph, bandLabel, clampGain, equaliserSupported, isAppleMobile, preampDb } from './equaliser'

describe('equaliser', () => {
  beforeEach(() => { FakeAudioContext.instances = []; vi.stubGlobal('AudioContext', FakeAudioContext) })
  afterEach(() => vi.unstubAllGlobals())

  it('routes both elements through ten filters and a pre-amp, once each', () => {
    const graph = new EqualiserGraph()
    const [first, second] = [document.createElement('audio'), document.createElement('audio')]
    expect(graph.attach([first, second])).toBe(true)
    graph.attach([first, second])
    const context = FakeAudioContext.instances[0]
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(context.sources.map((source) => source.element)).toEqual([first, second])
    expect(context.sources[0].connections).toEqual([context.gains[0]])
    expect(context.filters.map((filter) => filter.frequency.value)).toEqual([...EQ_BANDS])
    expect(context.filters.map((filter) => filter.type)).toEqual(['lowshelf', ...Array(8).fill('peaking'), 'highshelf'])
    expect(context.gains[0].connections).toEqual([context.filters[0]])
    expect(context.filters[9].connections).toEqual([context.destination])
  })

  it('sets the band gains, turns the pre-amp down by the biggest boost, and flattens when switched off', () => {
    const graph = new EqualiserGraph()
    graph.attach([document.createElement('audio')])
    const context = FakeAudioContext.instances[0]
    graph.apply([6, 5, 4, 2, 0, 0, 0, 0, -3, 40], true)
    expect(context.filters.map((filter) => filter.gain.value)).toEqual([6, 5, 4, 2, 0, 0, 0, 0, -3, 12])
    expect(context.gains[0].gain.value).toBeCloseTo(10 ** (-12 / 20))
    graph.apply([6, 5, 4, 2, 0, 0, 0, 0, -3, 12], false)
    expect(context.filters.every((filter) => filter.gain.value === 0)).toBe(true)
    expect(context.gains[0].gain.value).toBe(1)
  })

  it('resumes a suspended context', () => {
    const graph = new EqualiserGraph()
    graph.resume()
    graph.attach([document.createElement('audio')])
    graph.resume()
    graph.resume()
    expect(FakeAudioContext.instances[0].resumes).toBe(1)
  })

  it('is not offered on iPhone or iPad, or without Web Audio', () => {
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)', maxTouchPoints: 5 })).toBe(false)
    expect(equaliserSupported()).toBe(true)
    vi.stubGlobal('AudioContext', undefined)
    expect(equaliserSupported()).toBe(false)
  })

  it('labels bands and keeps gains within ±12 dB', () => {
    expect(bandLabel(62)).toBe('62 Hz')
    expect(bandLabel(16000)).toBe('16 kHz')
    expect(clampGain(13.6)).toBe(12)
    expect(clampGain(-2.4)).toBe(-2)
    expect(clampGain(Number.NaN)).toBe(0)
    expect(preampDb([-3, -1])).toBe(-0)
    expect(preampDb([2, 5])).toBe(-5)
  })
})
