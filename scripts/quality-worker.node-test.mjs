import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyQuality, qualityMeetsTarget } from '../shared/quality.mjs'
import { qualityRecheckChanges, qualityTargetState, qualityWorkerSource, recoveryImportStatus, recoveryStatusForQuality, storedSourceQuality } from './quality-worker.mjs'

// Probe-like fixtures in the shape recovery-agent probe() returns: bitrate in bits per second.
const fixtures = [
  { name: 'FLAC 16/44.1', probe: { codec: 'flac', container: 'flac', bitrate: 912_000, sampleRate: 44_100 }, tier: 'lossless' },
  { name: 'ALAC in M4A', probe: { codec: 'alac', container: 'mov,mp4,m4a,3gp,3g2,mj2', bitrate: 1_010_000 }, tier: 'lossless' },
  { name: 'WAV PCM', probe: { codec: 'pcm_s16le', container: 'wav', bitrate: 1_411_200 }, tier: 'lossless' },
  { name: 'AIFF PCM big-endian', probe: { codec: 'pcm_s24be', container: 'aiff', bitrate: 2_116_800 }, tier: 'lossless' },
  { name: 'FLAC with no codec, container only', probe: { codec: null, container: 'flac', bitrate: null }, tier: 'lossless' },
  { name: 'Opus 160 kbps (YouTube 251)', probe: { codec: 'opus', container: 'webm', bitrate: 160_000 }, tier: 'transparent-lossy' },
  { name: 'Opus 128 kbps', probe: { codec: 'opus', container: 'ogg', bitrate: 128_000 }, tier: 'transparent-lossy' },
  { name: 'Opus 96 kbps', probe: { codec: 'opus', container: 'ogg', bitrate: 96_000 }, tier: 'lossy' },
  { name: 'AAC 256 kbps', probe: { codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2', bitrate: 256_000 }, tier: 'transparent-lossy' },
  { name: 'AAC 192 kbps', probe: { codec: 'aac', bitrate: 192_000 }, tier: 'transparent-lossy' },
  { name: 'AAC 128 kbps (YouTube 140)', probe: { codec: 'aac', bitrate: 128_000 }, tier: 'lossy' },
  { name: 'MP3 320 CBR', probe: { codec: 'mp3', container: 'mp3', bitrate: 320_000 }, tier: 'transparent-lossy' },
  { name: 'MP3 V0 averaging 243 kbps', probe: { codec: 'mp3', container: 'mp3', bitrate: 243_000 }, tier: 'transparent-lossy' },
  { name: 'MP3 V0 tagged, averaging 225 kbps', probe: { codec: 'mp3', bitrate: 225_000, tags: { encoder_settings: '-V 0' } }, tier: 'transparent-lossy' },
  { name: 'MP3 192 CBR', probe: { codec: 'mp3', bitrate: 192_000 }, tier: 'lossy' },
  { name: 'Vorbis 320', probe: { codec: 'vorbis', bitrate: 320_000 }, tier: 'lossy' },
  { name: 'MP3 with no bitrate', probe: { codec: 'mp3', bitrate: null }, tier: 'unknown' },
  { name: 'bitrate already in kbps', probe: { codec: 'mp3', bitrate: 256 }, tier: 'transparent-lossy' },
  { name: 'empty probe', probe: {}, tier: 'unknown' },
  { name: 'missing probe', probe: null, tier: 'unknown' },
]

for (const fixture of fixtures) {
  test(`classifies ${fixture.name} as ${fixture.tier}`, () => {
    assert.equal(classifyQuality(fixture.probe).tier, fixture.tier)
  })
}

test('each target accepts its own tier and better, never unknown', () => {
  const table = {
    lossless: { lossless: 'recovered', 'transparent-lossy': 'needs-upgrade', lossy: 'needs-upgrade', unknown: 'needs-upgrade' },
    'transparent-lossy': { lossless: 'recovered', 'transparent-lossy': 'recovered', lossy: 'needs-upgrade', unknown: 'needs-upgrade' },
    lossy: { lossless: 'recovered', 'transparent-lossy': 'recovered', lossy: 'recovered', unknown: 'needs-upgrade' },
  }
  const probes = { lossless: { codec: 'flac' }, 'transparent-lossy': { codec: 'mp3', bitrate: 243_000 }, lossy: { codec: 'aac', bitrate: 128_000 }, unknown: {} }
  for (const [target, expected] of Object.entries(table)) {
    for (const [tier, status] of Object.entries(expected)) {
      assert.equal(recoveryStatusForQuality(probes[tier], target), status, `${tier} against ${target}`)
    }
  }
  assert.equal(qualityMeetsTarget('lossy', 'not-a-target'), false, 'an unknown target falls back to transparent-lossy')
})

test('a completed import is judged against the saved target', () => {
  const saved = qualityTargetState.target
  try {
    qualityTargetState.target = 'transparent-lossy'
    assert.equal(recoveryImportStatus({ codec: 'opus', bitrate: 160_000 }), 'recovered')
    qualityTargetState.target = 'lossless'
    assert.equal(recoveryImportStatus({ codec: 'opus', bitrate: 160_000 }), 'needs-upgrade')
    assert.equal(recoveryImportStatus({ codec: 'flac' }), 'recovered')
  } finally { qualityTargetState.target = saved }
})

test('re-check uses the stored source quality and only reports items whose status changes', () => {
  const rows = [
    { id: 'a', status: 'needs-upgrade', codec: 'mp3', bitrate: 243_000, provenanceJson: null },
    { id: 'b', status: 'needs-upgrade', codec: 'aac', bitrate: 128_000, provenanceJson: null },
    { id: 'c', status: 'recovered', codec: 'flac', bitrate: null, provenanceJson: null },
    { id: 'd', status: 'needs-upgrade', codec: 'flac', provenanceJson: JSON.stringify({ sourceAudio: { quality: { codec: 'opus', bitrate: 160_000 } } }) },
    { id: 'a', status: 'needs-upgrade', codec: 'aac', bitrate: 96_000, provenanceJson: null },
  ]
  assert.deepEqual(storedSourceQuality(rows[3]), { codec: 'opus', bitrate: 160_000 })
  assert.deepEqual(qualityRecheckChanges(rows, 'transparent-lossy'), [{ id: 'a', status: 'recovered' }, { id: 'd', status: 'recovered' }])
  assert.deepEqual(qualityRecheckChanges(rows, 'lossless'), [])
})

test('the Worker source embeds the classifier without module imports', () => {
  assert.ok(!/\bimport\b.*from/.test(qualityWorkerSource))
  for (const name of ['classifyQuality', 'qualityRuleFor', 'qualityLooksV0', 'recoveryImportStatus', 'handleQualityRequest']) assert.match(qualityWorkerSource, new RegExp(`function ${name}\\(`))
})
