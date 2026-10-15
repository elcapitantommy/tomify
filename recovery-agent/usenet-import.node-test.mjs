import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findCompletedAudio } from './usenet.mjs'
import { albumArtistFor, folderAlbum, looseArtistKey, importRemainingUsenetFiles, importUsenetCompletion, importedUsenetSourceFiles, releaseTrackMetadata, selectUsenetImportFiles } from './usenet-import.mjs'

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
  await assert.rejects(importUsenetCompletion(job('release'), discovered.files, { recoveryRoot, ...harness(qualities) }), /already in the recovery library/)
})

test('release tags that differ only by accents, or were mangled to U+FFFD, use the requested artist and album', () => {
  const request = job('release', { artist: 'Mötley Crüe', album: 'Dr. Feelgood' }).request.track
  const mangled = releaseTrackMetadata('/release/01 - T.n.T. (Terror \'n Tryin\').flac', { tags: { ARTIST: 'M\ufffdtley Cr\ufffde', ALBUM: 'Dr. Feelgood' } }, request, 1)
  assert.equal(mangled.artist, 'Mötley Crüe')
  assert.equal(mangled.albumArtist, 'Mötley Crüe')
  const plain = releaseTrackMetadata('/release/02 - Dr. Feelgood.flac', { tags: { ARTIST: 'Mötley Crüe', ALBUM: 'Dr. Feelgood' } }, job('release', { artist: 'Motley Crue', album: 'Dr. Feelgood' }).request.track, 2)
  assert.equal(plain.artist, 'Motley Crue')
  assert.equal(plain.albumArtist, 'Motley Crue')
})

test('release import joins an existing artist folder whose name differs only by accents', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-accent-import-test-'))
  await mkdir(join(recoveryRoot, 'Motley Crue'), { recursive: true })
  const completed = await mkdtemp(join(tmpdir(), 'tomify-accent-completed-test-'))
  await writeFile(join(completed, '01 - Dr. Feelgood.flac'), 'one')
  const discovered = await findCompletedAudio(completed)
  const qualities = { '01 - Dr. Feelgood.flac': { codec: 'flac', container: 'flac', duration: 290, tags: { ARTIST: 'Mötley Crüe', ALBUM: 'Dr. Feelgood (30th Anniversary)' } } }
  const tools = harness(qualities, false)
  const result = await importUsenetCompletion(job('release', { artist: 'Mötley Crüe', album: 'Dr. Feelgood' }), discovered.files, { recoveryRoot, ...tools })
  assert.equal(result.importedTracks[0].path.startsWith(join(recoveryRoot, 'Motley Crue', 'Dr. Feelgood (30th Anniversary)')), true)
  assert.deepEqual(await readdir(recoveryRoot), ['Motley Crue'])
  assert.equal(tools.ffmpegCalls[0].includes('artist=Mötley Crüe'), true)
  assert.equal(tools.ffmpegCalls[0].some((value) => String(value).includes('\ufffd')), false)
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

test('a discography torrent imports each album into its own folder instead of failing on clashing track names', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-discography-import-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-discography-completed-test-'))
  const albums = { '1975 - That\'s the Way of the World [FLAC]': 'That\'s the Way of the World', '1977 - All \'n All [FLAC]': 'All \'n All' }
  const qualities = {}
  for (const [folder, album] of Object.entries(albums)) {
    await mkdir(join(completed, folder), { recursive: true })
    for (const [number, title] of [[1, 'Intro'], [2, 'Shining Star']]) {
      const path = join(completed, folder, `0${number} - ${title}.flac`)
      await writeFile(path, `${album} ${title}`)
      qualities[path] = { codec: 'flac', container: 'flac', duration: 200, tags: { title, artist: 'Earth, Wind & Fire', album, track: String(number) } }
    }
  }
  const discovered = await findCompletedAudio(completed)
  assert.equal(discovered.files.length, 4)
  const torrentJob = { ...job('release', { artist: 'Earth, Wind & Fire', album: null, releaseId: 'wanted-release-id' }), downloader: 'qbittorrent', indexer: { type: 'torrent', id: 'torrent-link', name: 'Torrent link' }, torrent: { infoHash: 'abc123', linkType: 'magnet' } }
  const tools = { ...harness(), probe: async (path) => qualities[path] || { codec: 'flac', container: 'flac', duration: 200, tags: {} } }
  const result = await importUsenetCompletion(torrentJob, discovered.files, { recoveryRoot, ...tools })

  assert.equal(result.importedCount, 4)
  assert.equal(result.artist, 'Earth, Wind & Fire')
  assert.equal(result.album, null)
  assert.deepEqual(result.albums.map((value) => value.album).sort(), ['All \'n All', 'That\'s the Way of the World'])
  assert.deepEqual((await readdir(join(recoveryRoot, 'Earth, Wind & Fire'))).sort(), ['All \'n All', 'That\'s the Way of the World'])
  for (const album of Object.values(albums)) {
    const files = (await readdir(join(recoveryRoot, 'Earth, Wind & Fire', album))).filter((name) => name.endsWith('.flac')).sort()
    assert.deepEqual(files, ['01 - Intro.flac', '02 - Shining Star.flac'])
  }
  // The wanted item names no album, so the chosen artwork and release id are not stamped on any of them.
  assert.equal(tools.artworkCalls, 0)
  assert.equal(result.importedTracks.every((track) => track.provenance.resolvedMetadata.releaseId === null), true)
  assert.equal(result.importedTracks[0].provenance.releaseImport.albumCount, 2)
})

test('untagged discography files take their album from their folder, and repeated names are kept side by side', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-untagged-discography-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-untagged-discography-completed-test-'))
  for (const path of ['Head to the Sky/01 - Intro.flac', 'Faces/CD1/01 - Intro.flac', 'Faces/CD2/01 - Intro.flac', 'Spirit/01 - Intro.flac', 'Spirit/Bonus/01 - Intro.flac']) {
    await mkdir(join(completed, path, '..'), { recursive: true })
    await writeFile(join(completed, path), path)
  }
  const discovered = await findCompletedAudio(completed)
  const qualities = Object.fromEntries(discovered.files.map((file) => [file.path, { codec: 'flac', container: 'flac', duration: 200, tags: file.path.includes('Spirit') ? { album: 'Spirit', title: 'Intro', track: '1' } : {} }]))
  const result = await importUsenetCompletion(job('release', { artist: 'Earth, Wind & Fire', album: 'Spirit' }), discovered.files, { recoveryRoot, ...harness(), probe: async (path) => qualities[path] })

  assert.equal(result.importedCount, 5)
  const artistFolder = join(recoveryRoot, 'Earth, Wind & Fire')
  assert.deepEqual((await readdir(artistFolder)).sort(), ['Faces', 'Head to the Sky', 'Spirit'])
  assert.deepEqual((await readdir(join(artistFolder, 'Faces'))).filter((name) => name.endsWith('.mp3') || name.endsWith('.flac')).sort(), ['01-01 - Intro.flac', '02-01 - Intro.flac'])
  assert.deepEqual((await readdir(join(artistFolder, 'Spirit'))).filter((name) => name.endsWith('.flac')).sort(), ['01 - Intro (2).flac', '01 - Intro.flac'])
  // Only the wanted album gets the chosen cover.
  await access(join(artistFolder, 'Spirit', 'cover.jpg'))
  await assert.rejects(access(join(artistFolder, 'Faces', 'cover.jpg')))
})

test('a discography that spells the band several ways imports under one artist, preferring the library spelling', async () => {
  const masterRoot = await mkdtemp(join(tmpdir(), 'tomify-master-test-'))
  await mkdir(join(masterRoot, 'Earth, Wind & Fire'))
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-artist-variants-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-artist-variants-completed-test-'))
  const albums = [['Gratitude', 'Earth Wind And Fire'], ['Spirit', 'Earth, Wind And Fire'], ['Faces', 'Earth Wind & Fire'], ['Boogie Wonderland', 'Earth, Wind & Fire with The Emotions']]
  const qualities = {}
  for (const [album, artist] of albums) {
    await mkdir(join(completed, album))
    const path = join(completed, album, '01 - Song.flac')
    await writeFile(path, album)
    qualities[path] = { codec: 'flac', container: 'flac', duration: 200, tags: { title: 'Song', track: '1', album, artist, album_artist: artist } }
  }
  const discovered = await findCompletedAudio(completed)
  const tools = { ...harness({}, false), probe: async (path) => qualities[path] }
  const result = await importUsenetCompletion(job('release', { artist: 'Earth, Wind, and Fire', album: null }), discovered.files, { recoveryRoot, masterRoot, ...tools })

  assert.equal(result.artist, 'Earth, Wind & Fire')
  assert.deepEqual((await readdir(recoveryRoot)).sort(), ['Earth, Wind & Fire', 'Earth, Wind & Fire with The Emotions'])
  const byAlbum = Object.fromEntries(result.importedTracks.map((track) => [track.album, track]))
  for (const album of ['Gratitude', 'Spirit', 'Faces']) {
    assert.equal(byAlbum[album].albumArtist, 'Earth, Wind & Fire')
    assert.equal(byAlbum[album].artist, 'Earth, Wind & Fire')
  }
  // A collaboration keeps its own credit.
  assert.equal(byAlbum['Boogie Wonderland'].albumArtist, 'Earth, Wind & Fire with The Emotions')
  assert.equal(tools.ffmpegCalls.filter((args) => args.includes('album_artist=Earth, Wind & Fire')).length, 3)

  // Without a library folder the release's most common spelling wins.
  const second = await mkdtemp(join(tmpdir(), 'tomify-artist-variants-second-test-'))
  const fallback = await importUsenetCompletion(job('release', { artist: 'Earth, Wind, and Fire', album: null }), discovered.files, { recoveryRoot: second, ...tools })
  assert.equal(fallback.artist, 'Earth Wind & Fire')
})

test('tracks with a guest artist and no album-artist tag stay on their album under the release artist', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-guest-artist-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-guest-artist-completed-test-'))
  await mkdir(join(completed, '50 Years Anniversary Album'))
  const qualities = {}
  for (const [number, artist] of [[1, 'Earth, Wind & Fire'], [2, 'Deniece Williams'], [3, 'Earth, Wind & Fire']]) {
    const path = join(completed, '50 Years Anniversary Album', `0${number} - Song ${number}.flac`)
    await writeFile(path, artist)
    qualities[path] = { codec: 'flac', container: 'flac', duration: 200, tags: { title: `Song ${number}`, track: String(number), album: '50 Years Anniversary Album', artist } }
  }
  const discovered = await findCompletedAudio(completed)
  const result = await importUsenetCompletion(job('release', { artist: 'Earth, Wind, and Fire', album: null }), discovered.files, { recoveryRoot, ...harness({}, false), probe: async (path) => qualities[path] })
  assert.deepEqual(result.importedTracks.map((track) => track.albumArtist), ['Earth, Wind & Fire', 'Earth, Wind & Fire', 'Earth, Wind & Fire'])
  assert.deepEqual(result.importedTracks.map((track) => track.artist), ['Earth, Wind & Fire', 'Deniece Williams', 'Earth, Wind & Fire'])
})

test('an album with no album-artist tag and no artist on most tracks is Various Artists', () => {
  const items = ['A', 'B', 'C'].map((artist) => ({ hasAlbumArtistTag: false, metadata: { artist } }))
  assert.equal(albumArtistFor(items, null), 'Various Artists')
  assert.equal(albumArtistFor([...items, { hasAlbumArtistTag: true, metadata: { artist: 'A', albumArtist: 'Compiler' } }], null), 'Compiler')
  assert.equal(albumArtistFor([{ hasAlbumArtistTag: false, metadata: { artist: 'A' } }, { hasAlbumArtistTag: false, metadata: { artist: 'A' } }, { hasAlbumArtistTag: false, metadata: { artist: 'B' } }], null), 'A')
})

test('a release skips tracks already recovered from the same file and renames ones that clash with a different file', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-existing-copy-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-existing-copy-completed-test-'))
  await mkdir(join(completed, 'Lola'))
  const qualities = {}
  for (const [number, title] of [[1, 'The Contenders'], [2, 'Strangers'], [3, 'Lola']]) {
    const path = join(completed, 'Lola', `0${number} - ${title}.mp3`)
    await writeFile(path, `${title} audio`)
    qualities[path] = { codec: 'mp3', container: 'mp3', duration: 200, tags: { title, track: String(number), album: 'Lola', artist: 'The Kinks' } }
  }
  const album = join(recoveryRoot, 'The Kinks', 'Lola')
  await mkdir(join(album, '.tomify-source'), { recursive: true })
  // Track 1 was recovered before from this very file; track 2's name holds a different recording.
  await writeFile(join(album, '01 - The Contenders.mp3'), 'derivative'); await writeFile(join(album, '.tomify-source', '01 - The Contenders.mp3'), 'The Contenders audio')
  await writeFile(join(album, '02 - Strangers.mp3'), 'other derivative'); await writeFile(join(album, '.tomify-source', '02 - Strangers.mp3'), 'another recording')
  const discovered = await findCompletedAudio(completed)
  const result = await importUsenetCompletion(job('release', { artist: 'The Kinks', album: null }), discovered.files, { recoveryRoot, ...harness({}, false), probe: async (path) => qualities[path] })

  assert.equal(result.importedCount, 2)
  assert.equal(result.alreadyPresentCount, 1)
  assert.deepEqual(result.importedTracks.map((track) => basename(track.path)), ['02 - Strangers (2).mp3', '03 - Lola.mp3'])
  assert.equal(await readFile(join(album, '.tomify-source', '02 - Strangers.mp3'), 'utf8'), 'another recording')
  assert.equal(result.sourceFiles.length, 3)
})

test('loose artist keys ignore punctuation, "&" versus "and", accents and a leading "The"', () => {
  assert.equal(looseArtistKey('Earth, Wind & Fire'), looseArtistKey('earth wind and fire'))
  assert.equal(looseArtistKey('Earth, Wind, and Fire'), looseArtistKey('Earth Wind And Fire'))
  assert.equal(looseArtistKey('The Beatles'), looseArtistKey('Beatles'))
  assert.equal(looseArtistKey('Mötley Crüe'), looseArtistKey('Motley Crue'))
  assert.notEqual(looseArtistKey('Earth, Wind & Fire with The Emotions'), looseArtistKey('Earth, Wind & Fire'))
})

test('reads the album and disc from a release folder name', () => {
  assert.deepEqual(folderAlbum('/download/Discography/1975 - Gratitude (FLAC 24bit) [WEB]/01 - Shining Star.flac'), { album: '1975 - Gratitude', discNumber: null })
  assert.deepEqual(folderAlbum('/download/Faces/Disc 2/01 - Intro.flac'), { album: 'Faces', discNumber: 2 })
  assert.deepEqual(folderAlbum('/download/Open Our Eyes (1974)/01.flac'), { album: 'Open Our Eyes (1974)', discNumber: null })
})

test('torrent imports record torrent provenance, including files unpacked from an archive', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-torrent-import-test-'))
  const extracted = await mkdtemp(join(tmpdir(), 'tomify-torrent-extracted-test-'))
  const file = join(extracted, '001', '07 - Birdhouse in Your Soul.flac')
  await mkdir(join(extracted, '001'), { recursive: true }); await writeFile(file, 'audio')
  const torrentJob = { ...job('track'), downloader: 'qbittorrent', indexer: { type: 'torrent', id: 'torrent-link', name: 'Torrent link' }, torrent: { infoHash: 'abc123', linkType: 'magnet' }, extractedPath: extracted }
  torrentJob.result = { ...torrentJob.result, detailsUrl: 'magnet:?xt=urn:btih:abc123' }
  const result = await importUsenetCompletion(torrentJob, [{ name: basename(file), path: file }], { recoveryRoot, ...harness({}, false) })
  assert.equal(result.provenance.source, 'torrent')
  assert.equal(result.provenance.archiveStatus, 'torrent-recovery-copy')
  assert.equal(result.provenance.torrentInfoHash, 'abc123')
  assert.equal(result.provenance.extractedFromArchive, true)
  assert.equal(result.provenance.sourceUrl, 'magnet:?xt=urn:btih:abc123')
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

test('imports the rest of a single-track download as a release without re-importing the first track', async () => {
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'tomify-remaining-import-test-'))
  const completed = await mkdtemp(join(tmpdir(), 'tomify-remaining-completed-test-'))
  for (const name of ['01 - Theme from Flood.mp3', '02 - Birdhouse in Your Soul.mp3', '03 - Lucky Ball and Chain.mp3']) await writeFile(join(completed, name), name)
  const { files } = await findCompletedAudio(completed)
  const tools = harness({}, false)
  const first = await importUsenetCompletion(job('track'), files, { recoveryRoot, ...tools })
  assert.deepEqual(first.sourceFiles, [join(completed, '02 - Birdhouse in Your Soul.mp3')])

  const completedJob = { ...job('track'), status: 'completed', importResult: first }
  const rest = await importRemainingUsenetFiles(completedJob, files, { recoveryRoot, ...tools })
  assert.equal(rest.importedCount, 2)
  assert.deepEqual(rest.importedTracks.map((track) => track.title), ['Theme from Flood', 'Lucky Ball and Chain'])
  assert.equal(rest.provenance.releaseImport.multiTrack, true)

  const afterRest = { ...completedJob, additionalImports: [{ sourceFiles: rest.sourceFiles }] }
  await assert.rejects(importRemainingUsenetFiles(afterRest, files, { recoveryRoot, ...tools }), /already been imported/)
  await assert.rejects(importRemainingUsenetFiles({ ...job('release'), status: 'completed' }, files, { recoveryRoot, ...tools }), /already imported as a whole release/)
  await assert.rejects(importRemainingUsenetFiles({ ...job('track'), status: 'downloading' }, files, { recoveryRoot, ...tools }), /Only a completed/)
})

test('works out the first import of jobs saved before source files were recorded', () => {
  const files = [
    { name: '01 - Theme from Flood.mp3', path: '/release/01 - Theme from Flood.mp3' },
    { name: '07 - Birdhouse in Your Soul.mp3', path: '/release/07 - Birdhouse in Your Soul.mp3' },
  ]
  const legacy = { ...job('track'), status: 'completed', importResult: { importedCount: 1 } }
  assert.deepEqual([...importedUsenetSourceFiles(legacy, files)], ['/release/07 - Birdhouse in Your Soul.mp3'])
})
