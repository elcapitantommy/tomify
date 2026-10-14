import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDerivativeArguments } from './artwork.mjs'
import { recoveryDerivativeExtension, recoveryDerivativeOperation } from './derivative.mjs'

test('remuxes Opus-in-WebM to an artwork-free .opus derivative without transcoding', () => {
  const extension = recoveryDerivativeExtension('source.webm', { codec: 'opus', container: 'matroska,webm' })
  assert.equal(extension, '.opus')
  const plan = buildDerivativeArguments({ sourcePath: 'source.webm', outputPath: `tagged${extension}`, coverPath: 'cover.jpg', tags: [] })
  assert.equal(plan.embedded, false)
  assert.equal(plan.storageMode, 'cover-file-only')
  assert.deepEqual(plan.args.slice(plan.args.indexOf('-c:a'), plan.args.indexOf('-c:a') + 2), ['-c:a', 'copy'])
  assert.ok(!plan.args.some((value) => /libopus|aac|libmp3lame/.test(value)))
  assert.equal(recoveryDerivativeOperation('.webm', extension, plan.embedded), 'ffmpeg-stream-copy-remux-and-tagging')
})

test('keeps compatible source extensions unchanged', () => {
  assert.equal(recoveryDerivativeExtension('source.webm', { codec: 'vorbis', container: 'matroska,webm' }), '.webm')
  assert.equal(recoveryDerivativeExtension('source.opus', { codec: 'opus', container: 'ogg' }), '.opus')
  assert.equal(recoveryDerivativeExtension('source.m4a', { codec: 'aac', container: 'mov,mp4,m4a' }), '.m4a')
})
