import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findCompletedAudio } from './usenet.mjs'
import { importUsenetCompletion } from './usenet-import.mjs'
import { existingTrackMatcher, findReleaseDirectory, listExistingTracks, preflightRelease } from './preflight.mjs'

const recordingId = '33333333-3333-4333-8333-000000000002'

// They Might Be Giants/Flood with one Tomify import (with a sidecar) and one file copied in by hand (tags only).
async function floodFixture() {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-preflight-test-'))
  const album = join(recoveryRoot, 'They Might Be Giants', 'Flood')
  await mkdir(join(album, '.tomify-source'), { recursive: true })
  await writeFile(join(album, '02 - Birdhouse in Your Soul.flac'), 'derivative')
  await writeFile(join(album, '02 - Birdhouse in Your Soul.flac.tomify.json'), JSON.stringify({ resolvedMetadata: { title: 'Birdhouse in Your Soul', trackNumber: 2, recordingId }, sourceAudio: { quality: { codec: 'flac' } } }))
  await writeFile(join(album, '.tomify-source', '02 - Birdhouse in Your Soul.flac'), 'original')
  await writeFile(join(album, 'track3.mp3'), 'hand copied')
  await writeFile(join(album, 'cover.jpg'), 'cover')
  const probe = async (path) => basename(path) === 'track3.mp3' ? { codec: 'mp3', bitrate: 128000, tags: { TITLE: 'Lucky Ball and Chain', track: '3/19' } } : null
  return { recoveryRoot, album, probe }
}

test('preflight lists the release directory tracks from sidecars and tags, ignoring case-only differences', async () => {
  const { recoveryRoot, album, probe } = await floodFixture()
  const result = await preflightRelease(recoveryRoot, { artist: 'they might be giants', album: 'FLOOD', title: '', mode: 'release' }, { probe })
  assert.equal(result.directory, await realpath(album))
  assert.equal(result.mode, 'release')
  assert.deepEqual(result.existing.map(({ file, title, trackNumber, recordingId: id, tier, source }) => ({ file, title, trackNumber, recordingId: id, tier, source })), [
    { file: '02 - Birdhouse in Your Soul.flac', title: 'Birdhouse in Your Soul', trackNumber: 2, recordingId, tier: 'lossless', source: 'sidecar' },
    { file: 'track3.mp3', title: 'Lucky Ball and Chain', trackNumber: 3, recordingId: null, tier: 'lossy', source: 'tags' },
  ])
})

test('preflight finds NFD directories for an NFC request, and the other way round', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-preflight-unicode-test-'))
  const nfd = join(recoveryRoot, 'Café Tacvba', 'Ré')
  await mkdir(nfd, { recursive: true })
  await writeFile(join(nfd, '01 - El Aparato.mp3'), 'audio')
  assert.equal(await findReleaseDirectory(recoveryRoot, 'Café Tacvba', 'Ré'), await realpath(nfd))

  const otherRoot = await mkdtemp(join(tmpdir(), 'tomify-preflight-unicode-test-'))
  const nfc = join(otherRoot, 'Björk', 'Post')
  await mkdir(nfc, { recursive: true })
  const result = await preflightRelease(otherRoot, { artist: 'björk', album: 'post', mode: 'release' })
  assert.equal(result.directory, await realpath(nfc))
  assert.deepEqual(result.existing, [])
})

test('preflight is read-only: a release with no directory yet creates nothing', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-preflight-readonly-test-'))
  await mkdir(join(recoveryRoot, 'They Might Be Giants'))
  assert.deepEqual(await preflightRelease(recoveryRoot, { artist: 'They Might Be Giants', album: 'Apollo 18', mode: 'release' }), { directory: null, mode: 'release', existing: [] })
  assert.deepEqual(await preflightRelease(recoveryRoot, { artist: 'Pixies', album: 'Doolittle', title: 'Debaser', mode: 'track' }), { directory: null, mode: 'track', existing: [] })
  assert.deepEqual(await readdir(recoveryRoot), ['They Might Be Giants'])
  assert.deepEqual(await readdir(join(recoveryRoot, 'They Might Be Giants')), [])
  assert.equal((await preflightRelease(join(recoveryRoot, 'missing'), { artist: 'a', album: 'b' })).directory, null)
})

test('a track with no sidecar or tags falls back to its file name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tomify-preflight-names-test-'))
  await writeFile(join(directory, '01-04 - Particle Man.ogg'), 'audio')
  const [track] = await listExistingTracks(directory)
  assert.deepEqual({ title: track.title, trackNumber: track.trackNumber, discNumber: track.discNumber, tier: track.tier, source: track.source }, { title: 'Particle Man', trackNumber: 4, discNumber: 1, tier: 'unknown', source: 'filename' })
})

test('the skipExisting matcher compares recording ids, then normalised title and track number', async () => {
  const { album, probe } = await floodFixture()
  const matches = await existingTrackMatcher(album, { probe })
  assert.equal(matches({ title: 'Something else', trackNumber: 9, recordingId }), true)
  assert.equal(matches({ title: 'Other', trackNumber: 9 }, { tags: { MUSICBRAINZ_TRACKID: recordingId.toUpperCase() } }), true)
  assert.equal(matches({ title: 'birdhouse in your soul!', trackNumber: 2 }), true)
  assert.equal(matches({ title: 'Lucky Ball & Chain', trackNumber: 3 }), true)
  assert.equal(matches({ title: 'Birdhouse in Your Soul', trackNumber: 5 }), false)
})

function releaseJob(skipExisting) {
  return {
    id: 'release-job', downloader: 'sabnzbd', indexer: { type: 'nzbindex', id: 'nzbindex', name: 'NZBIndex' },
    result: { externalId: 'external', resultId: 'result-id', title: 'Flood', searchMode: 'release' },
    request: { track: { artist: 'They Might Be Giants', album: 'Flood' }, artwork: null, authorisation: { basis: 'other-authorisation' }, skipExisting },
  }
}

async function floodDownload() {
  const completed = await mkdtemp(join(tmpdir(), 'tomify-preflight-download-test-'))
  const qualities = {}
  for (const [number, title] of [[1, 'Theme from Flood'], [2, 'Birdhouse in Your Soul'], [3, 'Lucky Ball and Chain']]) {
    const path = join(completed, `0${number} ${title}.mp3`)
    await writeFile(path, `${title} from the download`)
    qualities[path] = { codec: 'mp3', container: 'mp3', bitrate: 320000, duration: 180, tags: { title, track: String(number), album: 'Flood', artist: 'They Might Be Giants' } }
  }
  return { files: (await findCompletedAudio(completed)).files, qualities }
}

test('a release import with skipExisting leaves out tracks the destination already has', async () => {
  const { recoveryRoot, album, probe: fixtureProbe } = await floodFixture()
  const { files, qualities } = await floodDownload()
  const tools = {
    probe: async (path) => qualities[path] || await fixtureProbe(path) || { codec: 'mp3', container: 'mp3', bitrate: 320000, duration: 180, tags: {} },
    prepareArtwork: async () => null,
    run: async (_command, args) => { await writeFile(args.at(-1), 'derivative'); return { stdout: '', stderr: '' } },
    ffmpeg: 'ffmpeg',
  }
  const result = await importUsenetCompletion(releaseJob(true), files, { recoveryRoot, ...tools })
  assert.equal(result.importedCount, 1)
  assert.equal(result.skippedExistingCount, 2)
  assert.deepEqual(result.importedTracks.map((track) => basename(track.path)), ['01 - Theme from Flood.mp3'])
  assert.equal(result.sourceFiles.length, 3)
  assert.equal((await readdir(album)).includes('02 - Birdhouse in Your Soul.mp3'), false)
})

test('without skipExisting a release import still brings in every track', async () => {
  const { recoveryRoot, probe: fixtureProbe } = await floodFixture()
  const { files, qualities } = await floodDownload()
  const result = await importUsenetCompletion(releaseJob(false), files, {
    recoveryRoot,
    probe: async (path) => qualities[path] || await fixtureProbe(path) || { codec: 'mp3', container: 'mp3', bitrate: 320000, duration: 180, tags: {} },
    prepareArtwork: async () => null,
    run: async (_command, args) => { await writeFile(args.at(-1), 'derivative'); return { stdout: '', stderr: '' } },
    ffmpeg: 'ffmpeg',
  })
  assert.equal(result.importedCount, 3)
  assert.equal(result.skippedExistingCount, 0)
})
