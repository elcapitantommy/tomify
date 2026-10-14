import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findCompletedAudio } from './usenet.mjs'
import { importUsenetCompletion, releaseTrackMetadata, selectUsenetImportFiles } from './usenet-import.mjs'

function job(searchMode, track = {}) {
  return {
    id: 'release-acquisition-id', downloader: 'sabnzbd', indexer: { type: 'nzbindex', id: 'nzbindex', name: 'NZBIndex' },
    result: { externalId: 'external', resultId: 'result-id', title: 'Posted release', detailsUrl: 'https://www.nzbindex.com/collection/result-id', searchMode, postedAt: '2026-01-01T00:00:00.000Z', size: 1234, ageDays: 2 },
    request: { track: { artist: 'they might be giants', album: 'flood', title: 'Birdhouse in Your Soul', releaseDate: '1990', releaseId: 'release-id', releaseGroupId: 'release-group-id', recordingId: 'seed-recording-id', trackNumber: 7, ...track }, wantedMetadata: null, catalogueSource: null, metadataResolution: null, artwork: { provider: 'apple' }, authorisation: { basis: 'other-authorisation', confirmedBy: 'tom', confirmedAt: '2026-01-01T00:00:00.000Z' } },
  }
}

function harness(qualities = {}, withArtwork = true) {
  let artworkCalls = 0
  const ffmpegCalls = []
  return {
    get artworkCalls() { return artworkCalls },
    ffmpegCalls,
    probe: async (path) => qualities[basename(path)] || { codec: 'mp3', container: 'mp3', bitrate: 256000, sampleRate: 44100, channels: 2, duration: 180, tags: {} },
    prepareArtwork: async (_candidate, temporaryRoot) => {
      if (!withArtwork) return null
      artworkCalls += 1
      const coverPath = join(temporaryRoot, 'cover.jpg')
      await writeFile(coverPath, 'cover')
      return { coverPath, provider: 'apple', providerLabel: 'Apple', providerId: 'cover-id', originalUrl: 'https://example.test/original', fetchedUrl: 'https://example.test/fetched', fetchedDimensions: { width: 1200, height: 1200 }, finalDimensions: { width: 1200, height: 1200 }, sourceMimeType: 'image/jpeg', finalMimeType: 'image/jpeg', acquiredAt: '2026-01-01T00:00:00.000Z' }
    },
    run: async (_command, args) => { ffmpegCalls.push(args); await writeFile(args.at(-1), 'derivative'); return { stdout: '', stderr: '' } },
    ffmpeg: 'ffmpeg',
  }
}

test('track and artist modes import only the best matching completed audio file', () => {
  const files = [
    { name: '01 - Theme from Flood.mp3', path: '/release/01 - Theme from Flood.mp3' },
    { name: '07 - Birdhouse in Your Soul.mp3', path: '/release/07 - Birdhouse in Your Soul.mp3' },
  ]
  assert.deepEqual(selectUsenetImportFiles(files, { title: 'Birdhouse in Your Soul' }, 'track').map((file) => file.name), ['07 - Birdhouse in Your Soul.mp3'])
  assert.deepEqual(selectUsenetImportFiles(files, { title: 'Birdhouse in Your Soul' }, 'artist').map((file) => file.name), ['07 - Birdhouse in Your Soul.mp3'])
  assert.equal(selectUsenetImportFiles(files, {}, 'release').length, 2)
})

test('prefers embedded release tags and falls back to filename order without seed recording metadata', () => {
  const embedded = releaseTrackMetadata('/release/arbitrary.mp3', { tags: { TITLE: 'Embedded title', ARTIST: 'Track Artist', ALBUM_ARTIST: 'Album Artist', ALBUM: 'Album', TRACK: '3/12', DISCNUMBER: '2/2', DATE: '1990-01-02' } }, job('release').request.track, 9)
  assert.deepEqual(embedded, { artist: 'Track Artist', albumArtist: 'Album Artist', album: 'Album', title: 'Embedded title', trackNumber: 3, discNumber: 2, releaseDate: '1990-01-02', releaseId: 'release-id', releaseGroupId: 'release-group-id', recordingId: null, isrc: null })
  const fallback = releaseTrackMetadata('/release/04 - Your Racist Friend.mp3', { tags: {} }, job('release').request.track, 9)
  assert.equal(fallback.title, 'Your Racist Friend')
  assert.equal(fallback.trackNumber, 4)
  assert.equal(fallback.recordingId, null)
})

test('release mode imports every audio file with shared artwork, originals, derivatives, sidecars, and one canonical directory', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-release-import-test-'))
  const canonicalAlbum = join(recoveryRoot, 'They Might Be Giants', 'Flood')
  await mkdir(canonicalAlbum, { recursive: true })
  const completed = await mkdtemp(join(tmpdir(), 'tomify-release-completed-test-'))
  await writeFile(join(completed, '01 - Theme from Flood.mp3'), 'one')
  await writeFile(join(completed, '02 - Birdhouse in Your Soul.mp3'), 'two')
  await writeFile(join(completed, 'notes.txt'), 'not audio')
  const discovered = await findCompletedAudio(completed)
  assert.equal(discovered.files.length, 2)

  const qualities = {
    '01 - Theme from Flood.mp3': { codec: 'mp3', container: 'mp3', duration: 45, tags: { title: 'Theme from Flood', artist: 'They Might Be Giants', album_artist: 'They Might Be Giants', album: 'Flood', track: '1/19', date: '1990' } },
    '02 - Birdhouse in Your Soul.mp3': { codec: 'mp3', container: 'mp3', duration: 190, tags: { artist: 'they might be giants', album: 'flood' } },
  }
  const tools = harness(qualities)
  const result = await importUsenetCompletion(job('release'), discovered.files, { recoveryRoot, ...tools })

  assert.equal(result.importedCount, 2)
  assert.equal(result.importedTracks.length, 2)
  assert.equal(result.artist, 'They Might Be Giants')
  assert.equal(result.album, 'Flood')
  assert.equal(tools.artworkCalls, 1)
  await access(join(canonicalAlbum, 'cover.jpg'))
  for (const track of result.importedTracks) {
    assert.equal(track.path.startsWith(canonicalAlbum), true)
    assert.equal(track.originalPath.startsWith(join(canonicalAlbum, '.tomify-source')), true)
    await access(track.path)
    await access(track.originalPath)
    const provenance = JSON.parse(await readFile(`${track.path}.tomify.json`, 'utf8'))
    assert.equal(provenance.source, 'usenet')
    assert.equal(provenance.sourceAudio.preservedOriginal, true)
    assert.equal(provenance.releaseImport.multiTrack, true)
    assert.equal(provenance.releaseImport.acquisitionId, 'release-acquisition-id')
    assert.equal(provenance.resolvedMetadata.recordingId, null)
  }
  assert.equal(result.importedTracks[0].title, 'Theme from Flood')
  assert.equal(result.importedTracks[0].trackNumber, 1)
  assert.equal(result.importedTracks[1].title, 'Birdhouse in Your Soul')
  assert.equal(result.importedTracks[1].trackNumber, 2)
  assert.equal(tools.ffmpegCalls.length, 2)
  assert.equal(tools.ffmpegCalls.every((args) => args.filter((value) => value === '-i').length === 2), true)
  assert.equal(tools.ffmpegCalls.some((args) => args.some((value) => String(value).startsWith('MUSICBRAINZ_TRACKID='))), false)
  await assert.rejects(importUsenetCompletion(job('release'), discovered.files, { recoveryRoot, ...harness(qualities) }), /will not overwrite/)
})

test('single-track mode preserves the existing one-result payload shape', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-track-import-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-track-completed-test-'))
  const wanted = join(completed, '07 - Birdhouse in Your Soul.mp3')
  const other = join(completed, '01 - Theme from Flood.mp3')
  await writeFile(wanted, 'wanted'); await writeFile(other, 'other')
  const files = [{ name: basename(other), path: other }, { name: basename(wanted), path: wanted }]
  const result = await importUsenetCompletion(job('track'), files, { recoveryRoot, ...harness({}, false) })
  assert.equal(result.importedCount, 1)
  assert.equal(result.importedTracks.length, 1)
  assert.equal(result.path, result.importedTracks[0].path)
  assert.equal(result.provenance.searchMode, 'track')
  assert.equal((await readdir(join(recoveryRoot, 'they might be giants', 'flood'))).filter((name) => name.endsWith('.mp3')).length, 1)
})

test('rejects a symlinked preserved-original directory outside the recovery root', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-output-symlink-test-'))
  const albumDirectory = join(recoveryRoot, 'they might be giants', 'flood')
  const outside = await mkdtemp(join(tmpdir(), 'tomify-output-symlink-target-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-output-symlink-completed-'))
  await mkdir(albumDirectory, { recursive: true })
  await symlink(outside, join(albumDirectory, '.tomify-source'), 'junction')
  const source = join(completed, '07 - Birdhouse in Your Soul.mp3')
  await writeFile(source, 'audio')
  await assert.rejects(importUsenetCompletion(job('track'), [{ name: basename(source), path: source }], { recoveryRoot, ...harness({}, false) }), /Unsafe recovery destination/)
  assert.deepEqual(await readdir(outside), [])
})
