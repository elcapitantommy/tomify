import test from 'node:test'
import assert from 'node:assert/strict'
import { reportLibraryInventory } from './inventory-report.mjs'

function audio(path, library, { artist, album, title, track = 1, disc = 1, duration = 180, recordingId = null, releaseId = null, size = 1000, fingerprint = null } = {}) {
  return { path, library, size, fingerprint, probe: { duration }, tags: { artist, albumArtist: artist, album, title, trackNumber: track, discNumber: disc, recordingId, releaseId, releaseGroupId: null } }
}

test('stored inventory report covers duplicates, near-name directories, partial albums, source orphans, and recovery shadows', () => {
  const floodRelease = 'release-flood'
  const files = [
    audio('/master/Earth, Wind & Fire/Flood/01 Theme.flac', 'master', { artist: 'Earth Wind & Fire', album: 'Flood', title: 'Theme', track: 1, duration: 45, recordingId: 'rec-theme', releaseId: floodRelease, fingerprint: 'same-audio', size: 111 }),
    audio('/master/Earth Wind and Fire/Flood/03 Birdhouse.flac', 'master', { artist: 'Earth Wind & Fire', album: 'Flood', title: 'Birdhouse', track: 3, duration: 190, recordingId: 'rec-bird', releaseId: floodRelease }),
    audio('/recovery/earth wind fire/Flood/01 Theme copy.flac', 'recovery', { artist: 'Earth Wind & Fire', album: 'Flood', title: 'Theme', track: 1, duration: 46, recordingId: 'rec-theme', releaseId: floodRelease, fingerprint: 'same-audio', size: 111 }),
    audio('/master/Zara Larson/So Good/Lush Life.flac', 'master', { artist: 'Zara Larsson', album: 'So Good', title: 'Lush Life', duration: 201 }),
    audio('/master/Zara Larsson/Poster Girl/Love Me Land.flac', 'master', { artist: 'Zara Larsson', album: 'Poster Girl', title: 'Love Me Land', duration: 200 }),
    audio('/master/The Kinks/Village Green/01 Village Green.flac', 'master', { artist: 'The Kinks', album: 'Village Green', title: 'Village Green', duration: 155 }),
    audio('/recovery/Kinks/Singles/01 Waterloo Sunset.flac', 'recovery', { artist: 'The Kinks', album: 'Singles', title: 'Waterloo Sunset', duration: 195 }),
  ]
  const inventory = {
    completedAt: '2026-10-16T12:00:00.000Z', files,
    sourceFiles: [
      { path: '/recovery/earth wind fire/Flood/.tomify-source/theme.flac', library: 'recovery' },
      { path: '/recovery/orphan/.tomify-source/lost.flac', library: 'recovery' },
    ],
    sidecars: [
      { path: '/recovery/earth wind fire/Flood/01 Theme copy.flac.tomify.json', audioPath: files[2].path, sourcePath: '/recovery/earth wind fire/Flood/.tomify-source/theme.flac', orphan: false },
      { path: '/recovery/gone.flac.tomify.json', audioPath: '/recovery/gone.flac', sourcePath: '/recovery/gone/.tomify-source/gone.flac', orphan: true },
    ],
  }
  const tracklists = [{ albumId: 'album-flood', releaseId: floodRelease, title: 'Flood', artist: 'Earth Wind & Fire', tracks: [
    { disc: 1, number: 1, title: 'Theme', recordingId: 'rec-theme' }, { disc: 1, number: 2, title: 'Lucky Ball and Chain', recordingId: 'rec-lucky' }, { disc: 1, number: 3, title: 'Birdhouse', recordingId: 'rec-bird' },
  ] }]
  const report = reportLibraryInventory(inventory, { tracklists, checkPaths: [files[0].path, '/recovery/missing.flac'] })

  assert.equal(report.completedAt, inventory.completedAt)
  assert.equal(report.duplicates.some((entry) => entry.kind === 'content' && entry.paths.length === 2), true)
  assert.equal(report.duplicates.some((entry) => entry.kind === 'recording' && entry.paths.includes(files[0].path) && entry.paths.includes(files[2].path)), true)
  const directoryLabels = report.duplicates.filter((entry) => entry.kind === 'directory').map((entry) => entry.label).join(' | ')
  assert.match(directoryLabels, /Earth, Wind & Fire/)
  assert.match(directoryLabels, /Zara Larson \/ Zara Larsson/)
  assert.match(directoryLabels, /The Kinks \/ Kinks|Kinks \/ The Kinks/)
  assert.equal(report.partialAlbums.some((entry) => entry.albumId === 'album-flood' && entry.missingTrackNumbers.some((track) => track.number === 2)), true)
  assert.deepEqual(report.orphanedSources.map((entry) => entry.kind).sort(), ['missing-source', 'orphan-sidecar', 'orphan-source'])
  assert.equal(report.shadowedRecovery.length, 1)
  assert.deepEqual(report.checkedPaths, { [files[0].path]: true, '/recovery/missing.flac': false })
})

test('equal sizes without a hash or fingerprint are not reported as identical content', () => {
  const files = [
    audio('/master/A/One/01.flac', 'master', { artist: 'A', album: 'One', title: 'First', size: 42 }),
    audio('/master/B/Two/01.flac', 'master', { artist: 'B', album: 'Two', title: 'Second', size: 42 }),
  ]
  const report = reportLibraryInventory({ files, sidecars: [], sourceFiles: [] })
  assert.equal(report.duplicates.some((entry) => entry.kind === 'content'), false)
})

test('numbered or Roman-numbered folders and folders under different artists are not reported as similar directories', () => {
  const files = [
    audio('/master/Queen/Greatest Hits 1/01.flac', 'master', { artist: 'Queen', album: 'Greatest Hits 1', title: 'Bohemian Rhapsody' }),
    audio('/master/Queen/Greatest Hits 2/01.flac', 'master', { artist: 'Queen', album: 'Greatest Hits 2', title: 'A Kind of Magic' }),
    audio('/master/Beatles/Past Masters I/01.flac', 'master', { artist: 'The Beatles', album: 'Past Masters I', title: 'From Me to You' }),
    audio('/master/Beatles/Past Masters II/01.flac', 'master', { artist: 'The Beatles', album: 'Past Masters II', title: 'Day Tripper' }),
    audio('/master/Billy Talent/Billy Talent II/01.flac', 'master', { artist: 'Billy Talent', album: 'Billy Talent II', title: 'Devil in a Midnight Mass' }),
    audio('/master/Billy Talent/Billy Talent III/01.flac', 'master', { artist: 'Billy Talent', album: 'Billy Talent III', title: 'Rusted from the Rain' }),
    audio('/master/Blur/Parklife/01.flac', 'master', { artist: 'Blur', album: 'Parklife', title: 'Girls & Boys' }),
    audio('/master/Pulp/Parklive/01.flac', 'master', { artist: 'Pulp', album: 'Parklive', title: 'Common People' }),
  ]
  const report = reportLibraryInventory({ files, sidecars: [], sourceFiles: [], roots: { master: '/master' } })
  assert.deepEqual(report.duplicates.filter((entry) => entry.kind === 'directory'), [])
})

test('a large inventory is reported without comparing every file with every other', () => {
  const files = []
  for (let artist = 0; artist < 400; artist += 1) for (let track = 1; track <= 50; track += 1) {
    files.push(audio(`/master/Artist ${artist}/Album/${track}.flac`, 'master', { artist: `Artist ${artist}`, album: 'Album', title: `Song ${track}`, track, duration: 100 + track * 5 }))
  }
  files.push(audio('/recovery/Artist 7/Album/3.flac', 'recovery', { artist: 'Artist 7', album: 'Album', title: 'Song 3', track: 3, duration: 116 }))
  const started = Date.now()
  const report = reportLibraryInventory({ files, sidecars: [], sourceFiles: [], roots: { master: '/master', recovery: '/recovery' } })
  assert.ok(Date.now() - started < 5000, `report took ${Date.now() - started} ms`)
  assert.equal(report.shadowedRecovery.length, 1)
  assert.equal(report.duplicates.filter((entry) => entry.kind === 'recording').length, 1)
})

test('a song on its original album and on a compilation is not a duplicate', () => {
  const files = [
    audio('/master/Queen/A Night at the Opera/11 Bohemian Rhapsody.flac', 'master', { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody', duration: 355, recordingId: 'rec-bo-rhap' }),
    audio('/master/Queen/Greatest Hits/01 Bohemian Rhapsody.flac', 'master', { artist: 'Queen', album: 'Greatest Hits', title: 'Bohemian Rhapsody', duration: 355, recordingId: 'rec-bo-rhap' }),
    audio('/recovery/Queen/Greatest Hits/01 Bohemian Rhapsody.flac', 'recovery', { artist: 'Queen', album: 'Greatest Hits', title: 'Bohemian Rhapsody', duration: 356 }),
    audio('/master/Queen/Greatest Hits/01 Bohemian Rhapsody (1).flac', 'master', { artist: 'Queen', album: 'Greatest Hits', title: 'Bohemian Rhapsody', duration: 355, recordingId: 'rec-bo-rhap' }),
  ]
  const report = reportLibraryInventory({ files, sidecars: [], sourceFiles: [], roots: { master: '/master', recovery: '/recovery' } })
  const recordings = report.duplicates.filter((entry) => entry.kind === 'recording')
  // Only the Greatest Hits copies count; the A Night at the Opera original stays out.
  assert.equal(recordings.length, 1)
  assert.deepEqual(recordings[0].paths, [files[1].path, files[3].path, files[2].path].sort())
  assert.equal(report.shadowedRecovery.length, 1)
  assert.equal(report.shadowedRecovery[0].masterPaths.includes(files[0].path), false)
})
