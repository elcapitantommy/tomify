import test from 'node:test'
import assert from 'node:assert/strict'
import { ffmpegMetadataArguments } from './metadata.mjs'

test('includes canonical MusicBrainz metadata and omits unavailable values', () => {
  const args = ffmpegMetadataArguments({ artist: 'Zara Larsson', albumArtist: 'Various Artists', title: 'Lush Life', album: 'So Good', releaseDate: '2017-03-17', trackNumber: 2, discNumber: 1, recordingId: 'recording-id', releaseId: 'release-id', releaseGroupId: 'group-id', isrc: 'SE3R41500004', sourceUrl: 'https://www.youtube.com/watch?v=test' }, 'Tomify recovery')
  const tags = args.filter((_, index) => index % 2 === 1)
  assert.ok(tags.includes('artist=Zara Larsson'))
  assert.ok(tags.includes('album_artist=Various Artists'))
  assert.ok(tags.includes('title=Lush Life'))
  assert.ok(tags.includes('date=2017-03-17'))
  assert.ok(tags.includes('MUSICBRAINZ_TRACKID=recording-id'))
  assert.ok(tags.includes('ISRC=SE3R41500004'))
  assert.ok(!tags.some((tag) => tag.endsWith('=undefined')))
})

test('tags the measured quality tier instead of calling every file lossy', () => {
  const status = (quality) => ffmpegMetadataArguments({ title: 'Lush Life' }, null, quality).find((value) => value.startsWith('TOMIFY_ARCHIVE_STATUS='))
  assert.equal(status({ codec: 'flac', bitrate: 900_000 }), 'TOMIFY_ARCHIVE_STATUS=lossless')
  assert.equal(status({ codec: 'mp3', bitrate: 243_000 }), 'TOMIFY_ARCHIVE_STATUS=transparent-lossy')
  assert.equal(status({ codec: 'aac', bitrate: 128_000 }), 'TOMIFY_ARCHIVE_STATUS=lossy')
  assert.equal(status(undefined), 'TOMIFY_ARCHIVE_STATUS=unknown')
  assert.ok(!ffmpegMetadataArguments({ title: 'Lush Life' }, null, { codec: 'flac' }).some((value) => value.includes('lossy-recovery-copy')))
})
