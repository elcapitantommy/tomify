import { describe, expect, it } from 'vitest'
import { qualityLabel, scoreRecoveryCandidate } from './recovery'

describe('recovery candidate matching', () => {
  it('favours an official, duration-matched upload', () => {
    const wanted = { artist: 'Feeder', title: 'Sweet 16', duration: 214 }
    const official = scoreRecoveryCandidate(wanted, { title: 'Feeder - Sweet 16 (Official Audio)', channel: 'FeederVEVO', duration: 214 })
    const live = scoreRecoveryCandidate(wanted, { title: 'Feeder - Sweet 16 live at Reading', channel: 'Fan Uploads', duration: 260 })
    expect(official.official).toBe(true)
    expect(official.score).toBeGreaterThan(90)
    expect(live.score).toBeLessThan(official.score)
  })

  it('does not claim unknown quality before inspection', () => {
    expect(qualityLabel({})).toBe('Quality measured after import')
    expect(qualityLabel({ codec: 'aac', bitrate: 128_000, sampleRate: 44_100, channels: 2 })).toBe('AAC · 128 kbps · 44.1 kHz · 2 ch')
  })
})
