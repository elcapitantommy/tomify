import test from 'node:test'
import assert from 'node:assert/strict'
import { buildArtworkProvenance, buildDerivativeArguments, coverDimensions, detectImageMime, validateArtworkUrl } from './artwork.mjs'

test('validates artwork hosts, MIME type, and image signatures', () => {
  assert.match(validateArtworkUrl('https://is1-ssl.mzstatic.com/image/cover.jpg'), /mzstatic/)
  assert.throws(() => validateArtworkUrl('https://example.com/cover.jpg'), /not allowed/)
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer, 'image/jpeg'), 'image/jpeg')
  assert.throws(() => detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff]).buffer, 'text/html'), /not an image/)
  assert.throws(() => detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff]).buffer, 'image/png'), /does not match/)
})

test('targets approximately 1200 square without upscaling low-resolution art', () => {
  assert.deepEqual(coverDimensions(2400, 2400), { width: 1200, height: 1200, filter: 'scale=1200:1200' })
  assert.deepEqual(coverDimensions(500, 500), { width: 500, height: 500, filter: 'scale=500:500' })
  assert.throws(() => coverDimensions(100, 100), /too small/)
})

test('embeds artwork only in supported containers and always stream-copies audio', () => {
  const m4a = buildDerivativeArguments({ sourcePath: 'source.m4a', outputPath: 'tagged.m4a', coverPath: 'cover.jpg', tags: [] })
  assert.equal(m4a.embedded, true)
  assert.deepEqual(m4a.args.slice(m4a.args.indexOf('-c:a'), m4a.args.indexOf('-c:a') + 2), ['-c:a', 'copy'])
  assert.ok(m4a.args.includes('attached_pic'))
  const webm = buildDerivativeArguments({ sourcePath: 'source.webm', outputPath: 'tagged.webm', coverPath: 'cover.jpg', tags: [] })
  assert.equal(webm.embedded, false)
  assert.equal(webm.storageMode, 'cover-file-only')
  assert.deepEqual(webm.args.slice(webm.args.indexOf('-c:a'), webm.args.indexOf('-c:a') + 2), ['-c:a', 'copy'])
  assert.ok(!webm.args.some((value) => /libopus|aac|libmp3lame/.test(value)))
})

test('artwork provenance records provider, dimensions, MIME, time, and storage mode', () => {
  const artwork = { provider: 'apple', providerLabel: 'Apple catalogue', providerId: '42', originalUrl: 'https://is1-ssl.mzstatic.com/source.jpg', fetchedUrl: 'https://is1-ssl.mzstatic.com/source.jpg', fetchedDimensions: { width: 1400, height: 1400 }, finalDimensions: { width: 1200, height: 1200 }, sourceMimeType: 'image/jpeg', finalMimeType: 'image/jpeg', acquiredAt: '2026-10-13T00:00:00.000Z' }
  const provenance = buildArtworkProvenance(artwork, { embedded: true, storageMode: 'embedded-and-cover-file' }, '/srv/music-recovery/Artist/Album/cover.jpg')
  assert.equal(provenance.provider, 'apple')
  assert.deepEqual(provenance.finalDimensions, { width: 1200, height: 1200 })
  assert.equal(provenance.sourceMimeType, 'image/jpeg')
  assert.equal(provenance.embedded, true)
  assert.equal(provenance.storedAsCoverFile, true)
})
