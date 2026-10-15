import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRecoveryMetadataChoices, recoveryImportStatus, resolveRecoveryMetadata } from './recovery-metadata.mjs'

function recording(overrides = {}) {
  return {
    id: 'recording-id', score: 100, title: 'Lush Life', length: 202000, isrcs: ['SE3R41500004'],
    'artist-credit': [{ name: 'Zara Larsson' }], 'first-release-date': '2015-06-05',
    releases: [{ id: 'release-id', title: 'So Good', date: '2017-03-17', status: 'Official', 'release-group': { id: 'group-id' }, media: [{ position: 1, track: [{ number: '2', title: 'Lush Life', recording: { id: 'recording-id' } }] }] }],
    ...overrides,
  }
}

test('corrects Zara Larson and lowercase title with a strong canonical match', () => {
  const result = resolveRecoveryMetadata({ artist: 'Zara Larson', title: 'lush life', album: 'So Good', duration: 202 }, [recording()])
  assert.equal(result.strong, true)
  assert.equal(result.metadata.artist, 'Zara Larsson')
  assert.equal(result.metadata.title, 'Lush Life')
  assert.ok(result.confidence >= 90)
})

test('a strong duration match outranks a materially different recording', () => {
  const close = recording()
  const distant = recording({ id: 'other-id', length: 260000, score: 100 })
  const result = resolveRecoveryMetadata({ artist: 'Zara Larsson', title: 'Lush Life', duration: 202 }, [distant, close])
  assert.equal(result.metadata.recordingId, 'recording-id')
  assert.equal(result.strong, true)
})

test('an exact wanted ISRC is a strong canonical matching signal', () => {
  const wrongIsrc = recording({ id: 'wrong-isrc', isrcs: ['OTHER0000001'], score: 100 })
  const exactIsrc = recording({ id: 'exact-isrc', isrcs: ['SE3R41500004'], score: 80 })
  const result = resolveRecoveryMetadata({ artist: 'Zara Larsson', title: 'Lush Life', duration: 202, isrc: 'SE3R41500004' }, [wrongIsrc, exactIsrc])
  assert.equal(result.metadata.recordingId, 'exact-isrc')
})

test('weak or ambiguous matches are not confirmed for automatic correction', () => {
  const first = recording({ id: 'first', title: 'Lush Life (remix)', 'artist-credit': [{ name: 'Zara Larsson' }] })
  const second = recording({ id: 'second', title: 'Lush Life (live)', 'artist-credit': [{ name: 'Zara Larsson' }] })
  const result = resolveRecoveryMetadata({ artist: 'Zara Larsson', title: 'Lush Life', duration: 202 }, [first, second])
  assert.equal(result.strong, false)
  const used = applyRecoveryMetadataChoices({ artist: 'Zara Larsson', title: 'Lush Life' }, result, { artist: true, title: true, album: true, releaseDate: true, trackNumbers: true })
  assert.equal(used.title, 'Lush Life')
  assert.equal(used.album, null)
})

test('user can opt out of one suggested correction', () => {
  const resolution = resolveRecoveryMetadata({ artist: 'Zara Larson', title: 'lush life', album: 'So Good', duration: 202 }, [recording()])
  const used = applyRecoveryMetadataChoices({ artist: 'Zara Larson', title: 'lush life', album: 'So Good' }, resolution, { artist: false, title: true, album: true, releaseDate: true, trackNumbers: true })
  assert.equal(used.artist, 'Zara Larson')
  assert.equal(used.title, 'Lush Life')
  assert.equal(used.trackNumber, 2)
})

test('lossless imports count as recovered while lossy ones still need a better copy', () => {
  assert.equal(recoveryImportStatus({ codec: 'flac', sampleRate: 96000 }), 'recovered')
  assert.equal(recoveryImportStatus({ codec: 'ALAC' }), 'recovered')
  assert.equal(recoveryImportStatus({ codec: 'pcm_s16le' }), 'recovered')
  assert.equal(recoveryImportStatus({ codec: 'opus' }), 'needs-upgrade')
  assert.equal(recoveryImportStatus({ codec: 'mp3' }), 'needs-upgrade')
  assert.equal(recoveryImportStatus(null), 'needs-upgrade')
})
