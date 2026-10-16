import { describe, expect, it } from 'vitest'
import { KEEP_ALIVE_MS, POLL_FAST_MS, POLL_MAX_MS, nextPollDelay, shouldPublish, snapshotSignature, type PublishableSnapshot } from './live-playback-timing'

const snapshot: PublishableSnapshot = {
  deviceId: 'desk', deviceName: 'Mac', queue: [{ id: '1', title: 'One', artist: 'A', album: 'X' }], currentIndex: 0, playing: true,
  currentTime: 20, duration: 200, volume: 0.8, muted: false, shuffle: false, repeat: 'off',
}
const record = { signature: snapshotSignature(snapshot), currentTime: 20, playing: true, at: 0 }

describe('live playback timing', () => {
  it('doubles the poll delay up to the cap and resets on change', () => {
    expect(nextPollDelay(POLL_FAST_MS, false)).toBe(3000)
    expect(nextPollDelay(6000, false)).toBe(POLL_MAX_MS)
    expect(nextPollDelay(POLL_MAX_MS, false)).toBe(POLL_MAX_MS)
    expect(nextPollDelay(POLL_MAX_MS, true)).toBe(POLL_FAST_MS)
  })

  it('skips publishing while playback progresses as extrapolated', () => {
    expect(shouldPublish({ ...snapshot, currentTime: 29 }, record, 9000)).toBe(false)
  })

  it('publishes on a seek, a state change or the keep-alive', () => {
    expect(shouldPublish({ ...snapshot, currentTime: 90 }, record, 9000)).toBe(true)
    expect(shouldPublish({ ...snapshot, currentTime: 29, shuffle: true }, record, 9000)).toBe(true)
    expect(shouldPublish({ ...snapshot, currentTime: 20 + KEEP_ALIVE_MS / 1000 }, record, KEEP_ALIVE_MS)).toBe(true)
    expect(shouldPublish(snapshot, null, 0)).toBe(true)
  })
})
