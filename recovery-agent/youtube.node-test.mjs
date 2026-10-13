import test from 'node:test'
import assert from 'node:assert/strict'
import { audioFormatSummary, sanitizeToolError, selectBestAudioFormat } from './youtube.mjs'

test('prefers the highest quality audio-only format', () => {
  const formats = [
    { format_id: 'video', acodec: 'aac', vcodec: 'h264', abr: 192, asr: 48000 },
    { format_id: 'low', acodec: 'opus', vcodec: 'none', abr: 96, asr: 48000 },
    { format_id: 'best', acodec: 'opus', vcodec: 'none', abr: 160, asr: 48000, audio_channels: 2 },
  ]
  assert.equal(selectBestAudioFormat(formats)?.format_id, 'best')
  assert.deepEqual(audioFormatSummary(formats[2]), { formatId: 'best', codec: 'opus', container: null, bitrate: 160, sampleRate: 48000, channels: 2, audioOnly: true })
})

test('redacts cookie paths and credential headers from tool failures', () => {
  const message = 'ERROR --cookies /opt/tomify/secrets/youtube.cookies Cookie: SID=secret'
  const safe = sanitizeToolError(message, ['/opt/tomify/secrets/youtube.cookies'])
  assert.doesNotMatch(safe, /youtube\.cookies|SID=secret/)
  assert.match(safe, /redacted/)
})
