import test from 'node:test'
import assert from 'node:assert/strict'
import { isReplayGainMode, replayGainDb, replayGainModes } from '../shared/replaygain.mjs'

test('ReplayGain modes are track and album', () => {
  assert.deepEqual(replayGainModes(), ['track', 'album'])
  assert.equal(isReplayGainMode('album'), true)
  assert.equal(isReplayGainMode('off'), false)
})

test('the chosen gain falls back to the other tag when one is missing', () => {
  const tags = { trackGain: -9.2, trackPeak: 0.95, albumGain: -8.1, albumPeak: 0.99 }
  assert.equal(replayGainDb(tags, 'track'), -9.2)
  assert.equal(replayGainDb(tags, 'album'), -8.1)
  assert.equal(replayGainDb({ trackGain: -6, trackPeak: 0.5 }, 'album'), -6)
  assert.equal(replayGainDb({ albumGain: -5, albumPeak: 0.5 }, 'track'), -5)
})

test('an untagged track, an unknown mode or a missing object has no gain', () => {
  assert.equal(replayGainDb({}, 'track'), null)
  assert.equal(replayGainDb({ trackPeak: 0.9 }, 'track'), null)
  assert.equal(replayGainDb(undefined, 'track'), null)
  assert.equal(replayGainDb({ trackGain: -3 }, 'off'), null)
  assert.equal(replayGainDb({ trackGain: Number.NaN }, 'track'), null)
})

test('a boost is capped so the peak stays 1 dB below full scale', () => {
  // Peak 0.5 is -6.02 dBFS, so at most +5.02 dB.
  assert.equal(replayGainDb({ trackGain: 8, trackPeak: 0.5 }, 'track'), 5.02)
  assert.equal(replayGainDb({ trackGain: 3, trackPeak: 0.5 }, 'track'), 3)
  // A cut is never made louder, but a hot peak still pulls it down to keep the headroom.
  assert.equal(replayGainDb({ trackGain: -0.5, trackPeak: 1 }, 'track'), -1)
  assert.equal(replayGainDb({ trackGain: 4 }, 'track'), 4)
})
