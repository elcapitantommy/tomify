import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInventoryController, inventoryStatePath } from './inventory.mjs'

async function treeSnapshot(root) {
  const rows = []
  async function visit(path, relative = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const details = await lstat(child)
      rows.push([name, entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file', details.size, details.mtimeMs])
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(child, name)
    }
  }
  await visit(root)
  return rows
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tomify-inventory-test-'))
  const masterRoot = join(root, 'master')
  const recoveryRoot = join(root, 'recovery')
  const stateRoot = join(root, 'state')
  const masterFlac = join(masterRoot, 'Kinks', 'Village Green', '01 - Village Green.flac')
  const masterMp3 = join(masterRoot, 'Kinks', 'Village Green', '02 - Do You Remember Walter.mp3')
  const recoveryFlac = join(recoveryRoot, 'kinks', 'Village Green', '03 - Picture Book.flac')
  const sourceFlac = join(recoveryRoot, 'kinks', 'Village Green', '.tomify-source', '03 - Picture Book.flac')
  for (const directory of [join(masterRoot, 'Kinks', 'Village Green'), join(recoveryRoot, 'kinks', 'Village Green', '.tomify-source'), stateRoot]) await mkdir(directory, { recursive: true })
  await writeFile(masterFlac, 'master flac')
  await writeFile(masterMp3, 'master mp3')
  await writeFile(recoveryFlac, 'recovery flac')
  await writeFile(sourceFlac, 'source flac')
  await writeFile(`${recoveryFlac}.tomify.json`, JSON.stringify({ source: 'usenet', sourceAudio: { path: sourceFlac } }))
  await writeFile(join(recoveryRoot, 'orphan.flac.tomify.json'), JSON.stringify({ source: 'torrent' }))
  await symlink(masterFlac, join(masterRoot, 'linked-copy.flac'))
  return { masterRoot, recoveryRoot, stateRoot, masterFlac, masterMp3, recoveryFlac, sourceFlac }
}

test('inventory is read-only, keeps case-distinct directories and orphan sidecars, skips symlinks, and summarizes the libraries', async () => {
  const paths = await fixture()
  const beforeMaster = await treeSnapshot(paths.masterRoot)
  const beforeRecovery = await treeSnapshot(paths.recoveryRoot)
  const calls = []
  const probe = async (path) => {
    calls.push(path)
    const mp3 = path.endsWith('.mp3')
    return { codec: mp3 ? 'mp3' : 'flac', container: mp3 ? 'mp3' : 'flac', bitrate: mp3 ? 128000 : 900000, sampleRate: 44100, duration: mp3 ? 143 : 180, tags: { artist: 'The Kinks', album_artist: 'The Kinks', album: 'The Kinks Are the Village Green Preservation Society', title: basename(path), track: mp3 ? '2/15' : '1/15', disc: '1/1', MUSICBRAINZ_TRACKID: 'recording-id', MUSICBRAINZ_ALBUMID: 'release-id', MUSICBRAINZ_RELEASEGROUPID: 'release-group-id' } }
  }
  const controller = createInventoryController({ ...paths, probe })

  assert.equal((await controller.start()).started, true)
  assert.equal((await controller.start()).started, false)
  const inventory = await controller.settled()

  assert.equal(inventory.files.length, 3)
  assert.equal(inventory.files.some((file) => file.path.endsWith('linked-copy.flac')), false)
  assert.equal(inventory.files.some((file) => file.path === paths.sourceFlac), false)
  assert.deepEqual(inventory.sourceFiles.map((file) => file.path), [paths.sourceFlac])
  assert.equal(inventory.files.some((file) => file.path.includes(join('master', 'Kinks'))), true)
  assert.equal(inventory.files.some((file) => file.path.includes(join('recovery', 'kinks'))), true)
  assert.equal(inventory.sidecars.find((sidecar) => sidecar.path.endsWith('orphan.flac.tomify.json')).orphan, true)
  const recovered = inventory.files.find((file) => file.path === paths.recoveryFlac)
  assert.deepEqual(recovered.sidecar, { path: `${paths.recoveryFlac}.tomify.json`, backend: 'usenet', sourcePath: paths.sourceFlac })
  assert.deepEqual(recovered.probe, { codec: 'flac', bitrate: 900000, sampleRate: 44100, duration: 180, tier: 'lossless' })
  assert.deepEqual(recovered.tags, { artist: 'The Kinks', albumArtist: 'The Kinks', album: 'The Kinks Are the Village Green Preservation Society', title: basename(paths.recoveryFlac), trackNumber: 1, discNumber: 1, recordingId: 'recording-id', releaseId: 'release-id', releaseGroupId: 'release-group-id', artistId: null, albumArtistId: null })
  assert.equal(calls.length, 3)
  assert.deepEqual(await controller.summary(), {
    completedAt: inventory.completedAt,
    byLibrary: { master: 2, recovery: 1 },
    byQualityTier: { lossless: 2, 'transparent-lossy': 0, lossy: 1, unknown: 0 },
    bySource: { unknown: 2, usenet: 1 },
    totals: { files: 3, bytes: 34, sidecars: 2, orphanSidecars: 1 },
  })
  assert.deepEqual(await treeSnapshot(paths.masterRoot), beforeMaster)
  assert.deepEqual(await treeSnapshot(paths.recoveryRoot), beforeRecovery)
  assert.deepEqual(await readdir(paths.stateRoot), ['library-inventory.json'])
  assert.equal(JSON.parse(await readFile(inventoryStatePath(paths.stateRoot), 'utf8')).version, 2)
})

test('a second inventory probes only the audio file whose size or mtime changed and drops deleted entries', async () => {
  const paths = await fixture()
  const firstCalls = []
  const first = createInventoryController({ ...paths, probe: async (path) => { firstCalls.push(path); return { codec: path.endsWith('.mp3') ? 'mp3' : 'flac', bitrate: 128000, sampleRate: 44100, duration: 100, tags: {} } } })
  await first.start(); await first.settled()
  assert.equal(firstCalls.length, 3)

  await writeFile(paths.masterMp3, 'changed master mp3 with a different size')
  await rm(paths.sourceFlac)
  const beforeMaster = await treeSnapshot(paths.masterRoot)
  const beforeRecovery = await treeSnapshot(paths.recoveryRoot)
  const secondCalls = []
  const second = createInventoryController({ ...paths, probe: async (path) => { secondCalls.push(path); return { codec: 'mp3', bitrate: 192000, sampleRate: 48000, duration: 144, tags: { title: 'Changed' } } } })
  await second.start()
  const inventory = await second.settled()

  assert.deepEqual(secondCalls, [paths.masterMp3])
  const status = await second.status()
  assert.equal(status.progress, 100)
  assert.equal(status.lastCompletedAt, inventory.completedAt)
  assert.equal(status.filesProbed, 1)
  assert.equal(status.filesReused, 2)
  assert.equal(inventory.files.length, 3)
  assert.equal(inventory.files.some((file) => file.path === paths.sourceFlac), false)
  assert.equal(inventory.files.find((file) => file.path === paths.masterMp3).tags.title, 'Changed')
  assert.deepEqual(await treeSnapshot(paths.masterRoot), beforeMaster)
  assert.deepEqual(await treeSnapshot(paths.recoveryRoot), beforeRecovery)
})

test('the recovery library mounted inside the master library is only inventoried as recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-inventory-test-'))
  const masterRoot = join(root, 'master')
  // On the media server /srv/music/_Recovery is a bind mount of /srv/music-recovery: the same directory under both roots.
  const recoveryRoot = join(masterRoot, '_Recovery')
  const stateRoot = join(root, 'state')
  await mkdir(join(masterRoot, 'Kinks'), { recursive: true })
  await mkdir(join(recoveryRoot, 'Flood'), { recursive: true })
  await mkdir(stateRoot)
  await writeFile(join(masterRoot, 'Kinks', '01.flac'), 'master')
  await writeFile(join(recoveryRoot, 'Flood', '01.flac'), 'recovery')
  const controller = createInventoryController({ masterRoot, recoveryRoot, stateRoot, probe: async () => ({ codec: 'flac', tags: {} }) })
  await controller.start()
  const inventory = await controller.settled()
  assert.deepEqual(inventory.files.map((file) => [file.library, file.path]), [['master', join(masterRoot, 'Kinks', '01.flac')], ['recovery', join(recoveryRoot, 'Flood', '01.flac')]])
})

test('a directory with an empty .ndignore is left out, like Navidrome does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-inventory-test-'))
  const masterRoot = join(root, 'master')
  const recoveryRoot = join(root, 'recovery')
  const stateRoot = join(root, 'state')
  await mkdir(join(masterRoot, 'Beatles'), { recursive: true })
  await mkdir(join(masterRoot, '_Duplicates', 'Beatles'), { recursive: true })
  await mkdir(join(masterRoot, 'Kinks'), { recursive: true })
  await mkdir(recoveryRoot)
  await mkdir(stateRoot)
  await writeFile(join(masterRoot, 'Beatles', '01.flac'), 'kept')
  await writeFile(join(masterRoot, '_Duplicates', '.ndignore'), '')
  await writeFile(join(masterRoot, '_Duplicates', 'Beatles', '01.mp3'), 'duplicate')
  // Navidrome treats a non-empty .ndignore as patterns, so the directory itself is still walked.
  await writeFile(join(masterRoot, 'Kinks', '.ndignore'), '*.tmp\n')
  await writeFile(join(masterRoot, 'Kinks', '01.flac'), 'kinks')
  const controller = createInventoryController({ masterRoot, recoveryRoot, stateRoot, probe: async () => ({ codec: 'flac', tags: {} }) })
  await controller.start()
  const inventory = await controller.settled()
  assert.deepEqual(inventory.files.map((file) => file.path), [join(masterRoot, 'Beatles', '01.flac'), join(masterRoot, 'Kinks', '01.flac')])
})
