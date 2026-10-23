import test from 'node:test'
import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFamilyImporter, filmIdentity, parseEpisodeName, parseFilmName, parseSeriesRelease, subtitleLanguage } from './family-import.mjs'

const HASH = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

// A temporary Family library with its staging folder, a fake qBittorrent and a fake ffprobe: no real torrent client,
// media tool or network is involved.
async function setup({ torrents = {}, probe = async () => ({ ok: true, duration: 5400 }) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'family-import-'))
  const library = join(root, 'family')
  await mkdir(join(library, '.downloads'), { recursive: true })
  const stateDir = join(root, 'state')
  const logs = []
  const qbittorrent = {
    async torrent(hash) { return torrents[hash] ? { ...torrents[hash].info, hash } : null },
    async files(hash) { return torrents[hash]?.files || [] },
    async list(category) { return Object.entries(torrents).filter(([, entry]) => entry.info.category === category).map(([hash, entry]) => ({ ...entry.info, hash })) },
  }
  const make = (options = {}) => createFamilyImporter({ library, stateDir, qbittorrent, probe, log: (entry) => logs.push(entry), stableMs: 0, ...options })
  return { root, library, staging: join(library, '.downloads'), stateDir, logs, make, torrents }
}

// Writes a torrent's files under staging and describes it as qBittorrent would once complete.
async function addTorrent(context, hash, name, files, extra = {}) {
  const savePath = context.staging
  const listed = []
  for (const [relative, content] of Object.entries(files)) {
    const path = join(savePath, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
    listed.push({ name: relative, size: Buffer.byteLength(content), progress: 1, priority: 1 })
  }
  context.torrents[hash] = { info: { name, category: 'tomifin-family', state: 'stalledUP', progress: 1, amount_left: 0, save_path: savePath, ...extra }, files: listed }
}

const film = 'x'.repeat(3000)

test('release names become Title (Year), and anything unclear is refused', () => {
  const cases = [
    ['Toy.Story.2.1999.1080p.BluRay.x264-YIFY', 'Toy Story 2 (1999)'],
    ['Toy Story 2 (1999) [1080p] [BluRay] [5.1] [YTS.MX]', 'Toy Story 2 (1999)'],
    ['The.Matrix.1999.REMASTERED.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-SWTYBLZ', 'The Matrix (1999)'],
    ['Blade Runner 2049 (2017) 1080p BrRip x264 - YIFY', 'Blade Runner 2049 (2017)'],
    ['1917.2019.1080p.WEBRip.x264.AAC5.1-[YTS.MX]', '1917 (2019)'],
    ['2001.A.Space.Odyssey.1968.1080p.BluRay.x264', '2001 A Space Odyssey (1968)'],
    ['Big Buck Bunny (2008)', 'Big Buck Bunny (2008)'],
    ['Sintel.2010.720p.mkv', 'Sintel (2010)'],
  ]
  for (const [name, expected] of cases) assert.equal(parseFilmName(name)?.name, expected, name)
  for (const name of ['Toy.Story.1080p.BluRay.x264', 'Breaking.Bad.S01E01.720p.HDTV', 'Some Show Season 2 1080p', '1999', '1080p.2019.BluRay', 'Movie 2019 Directors Cut Part Two Final']) {
    assert.equal(parseFilmName(name), null, name)
  }
  assert.equal(filmIdentity('Toy.Story.2.1999.1080p', 'Toy.Story.2.1999.1080p.mkv').identity.name, 'Toy Story 2 (1999)')
  assert.equal(filmIdentity('Some Pack of Films', 'Sintel.2010.720p.mkv').identity.name, 'Sintel (2010)')
  assert.match(filmIdentity('Toy.Story.2.1999.1080p', 'Toy.Story.3.2010.1080p.mkv').reason, /says/)
})

test('subtitle languages are used only when certain', () => {
  assert.deepEqual(subtitleLanguage('Subs/2_English.srt', 'Toy.Story.2.1999.mkv'), { language: 'en', flags: [] })
  assert.deepEqual(subtitleLanguage('Toy.Story.2.1999.en.srt', 'Toy.Story.2.1999.mkv'), { language: 'en', flags: [] })
  assert.deepEqual(subtitleLanguage('Toy.Story.2.1999.eng.forced.srt', 'Toy.Story.2.1999.mkv'), { language: 'en', flags: ['forced'] })
  assert.deepEqual(subtitleLanguage('Subs/English.SDH.srt', 'Film.mkv'), { language: 'en', flags: ['sdh'] })
  assert.deepEqual(subtitleLanguage('Toy.Story.2.1999.srt', 'Toy.Story.2.1999.mkv'), { language: null, flags: [] })
  // "Italian" belongs to the film's name here, not the subtitle's language.
  assert.deepEqual(subtitleLanguage('The.Italian.Job.1969.srt', 'The.Italian.Job.1969.mkv'), { language: null, flags: [] })
  assert.deepEqual(subtitleLanguage('English-French.srt', 'Film.mkv'), { language: null, flags: [] })
  assert.deepEqual(subtitleLanguage('it.srt', 'Film.mkv'), { language: null, flags: [] })
})

test('a finished film is published as hardlinks with clean names, and qBittorrent\'s files are untouched', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Toy.Story.2.1999.1080p.BluRay.x264-YIFY', {
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Toy.Story.2.1999.1080p.BluRay.x264-YIFY.mp4': film,
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Subs/2_English.srt': 'subtitle english full',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Subs/3_English.srt': 'short',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Subs/French.srt': 'subtitle french',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Toy.Story.2.1999.srt': 'unknown language',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/sample/sample.mp4': 'sample',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/www.YTS.MX.jpg': 'jpg',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/YTSProxies.com.txt': 'advert',
    'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Visit us.url': '[InternetShortcut]',
  })
  const before = await readdir(join(context.staging, 'Toy.Story.2.1999.1080p.BluRay.x264-YIFY'), { recursive: true })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published')
  const folder = join(context.library, 'Toy Story 2 (1999)')
  assert.deepEqual((await readdir(folder)).sort(), ['Toy Story 2 (1999).en.srt', 'Toy Story 2 (1999).fr.srt', 'Toy Story 2 (1999).mp4', 'Toy Story 2 (1999).srt'])
  assert.equal(await readFile(join(folder, 'Toy Story 2 (1999).en.srt'), 'utf8'), 'subtitle english full')
  const source = await stat(join(context.staging, 'Toy.Story.2.1999.1080p.BluRay.x264-YIFY/Toy.Story.2.1999.1080p.BluRay.x264-YIFY.mp4'))
  const published = await stat(join(folder, 'Toy Story 2 (1999).mp4'))
  assert.deepEqual([published.ino, published.nlink, source.nlink], [source.ino, 2, 2])
  assert.deepEqual(await readdir(join(context.staging, 'Toy.Story.2.1999.1080p.BluRay.x264-YIFY'), { recursive: true }), before, 'sources left exactly as they were')
  // The publishing area is hidden and marked for Jellyfin to skip, and left empty.
  assert.deepEqual(await readdir(join(context.library, '.publishing')), ['.ignore'])
  const log = context.logs.at(-1)
  assert.deepEqual([log.hash, log.title, log.year, log.result], [HASH, 'Toy Story 2', 1999, 'published'])
  assert.equal(log.skippedSubtitles.length, 1)
  assert.doesNotMatch(JSON.stringify(context.logs), /password|token/i)
})

test('running again changes nothing, and a dry run writes nothing', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  const dry = await context.make({ dryRun: true }).importTorrent(HASH)
  assert.equal(dry.result, 'would-publish')
  assert.deepEqual(dry.published, [join(context.library, 'Sintel (2010)', 'Sintel (2010).mkv')])
  assert.deepEqual((await readdir(context.library)).sort(), ['.downloads'])
  assert.equal(await lstat(context.stateDir).then(() => true, () => false), false)

  assert.equal((await context.make().importTorrent(HASH)).result, 'published')
  const snapshot = execFileSync('find', [context.library, '-printf', '%p %i %n %s\n']).toString()
  assert.equal((await context.make().importTorrent(HASH)).result, 'unchanged')
  // Even without its record, the same film is recognised by inode and not published twice.
  await writeFile(join(context.stateDir, `${HASH}.json`), '{}')
  assert.equal((await context.make().importTorrent(HASH)).result, 'already-imported')
  assert.equal(execFileSync('find', [context.library, '-printf', '%p %i %n %s\n']).toString().replace(/ \S+ \d+ \d+\n/g, '\n'), snapshot.replace(/ \S+ \d+ \d+\n/g, '\n'))
  assert.equal((await stat(join(context.library, 'Sintel (2010)', 'Sintel (2010).mkv'))).nlink, 2)
})

test('films can be published into a folder such as Movies, which must already exist inside the library', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  assert.throws(() => context.make({ moviesDir: '../elsewhere' }), /one plain folder name/)
  assert.throws(() => context.make({ moviesDir: '.hidden' }), /one plain folder name/)
  await assert.rejects(context.make({ moviesDir: 'Movies' }).importTorrent(HASH), /does not exist/)
  await mkdir(join(context.library, 'Movies'))
  const result = await context.make({ moviesDir: 'Movies' }).importTorrent(HASH)
  assert.equal(result.result, 'published')
  assert.deepEqual(result.published, [join(context.library, 'Movies', 'Sintel (2010)', 'Sintel (2010).mkv')])
  assert.equal((await stat(join(context.library, 'Movies', 'Sintel (2010)', 'Sintel (2010).mkv'))).nlink, 2)
  assert.equal(await lstat(join(context.library, 'Sintel (2010)')).then(() => true, () => false), false)
})

test('a film already published by hand (the same inode) is recorded, not duplicated', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Toy.Story.2.1999.1080p.BrRip.x264-YIFY', { 'Toy.Story.2.1999.1080p.BrRip.x264-YIFY/Toy.Story.2.1999.1080p.BrRip.x264-YIFY.mp4': film })
  await mkdir(join(context.library, 'Toy Story 2 (1999)'))
  await link(join(context.staging, 'Toy.Story.2.1999.1080p.BrRip.x264-YIFY/Toy.Story.2.1999.1080p.BrRip.x264-YIFY.mp4'), join(context.library, 'Toy Story 2 (1999)', 'Toy Story 2 (1999).mp4'))
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'already-imported')
  assert.deepEqual(await readdir(join(context.library, 'Toy Story 2 (1999)')), ['Toy Story 2 (1999).mp4'])
  assert.equal(await lstat(join(context.library, '.review')).then(() => true, () => false), false)
})

test('a different film already at the destination is never overwritten: it goes to review', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Sintel.2010.1080p', { 'Sintel.2010.1080p/Sintel.2010.1080p.mkv': film })
  await mkdir(join(context.library, 'Sintel (2010)'))
  await writeFile(join(context.library, 'Sintel (2010)', 'Sintel (2010).mkv'), 'y'.repeat(3000))
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'review')
  assert.match(result.reason, /different Sintel \(2010\)\.mkv; it was not overwritten/)
  assert.equal(await readFile(join(context.library, 'Sintel (2010)', 'Sintel (2010).mkv'), 'utf8'), 'y'.repeat(3000))
  const review = join(context.library, '.review', HASH)
  assert.deepEqual((await readdir(review)).sort(), ['Sintel.2010.1080p.mkv', 'reason.json'])
  assert.deepEqual((await readdir(join(context.library, '.review'))).sort(), ['.ignore', HASH])
  assert.equal(JSON.parse(await readFile(join(review, 'reason.json'), 'utf8')).hash, HASH)
  // Same content under the same name counts as already imported.
  const same = await setup()
  await addTorrent(same, OTHER, 'Sintel.2010.1080p', { 'Sintel.2010.1080p/Sintel.2010.1080p.mkv': film })
  await mkdir(join(same.library, 'Sintel (2010)'))
  await writeFile(join(same.library, 'Sintel (2010)', 'Sintel (2010).mkv'), film)
  assert.equal((await same.make().importTorrent(OTHER)).result, 'already-imported')
})

test('ambiguous names, several large videos, TV, unreadable or short videos are withheld for review', async () => {
  const cases = [
    ['no year', 'Toy.Story.1080p.BluRay', { 'Toy.Story.1080p.BluRay/Toy.Story.1080p.BluRay.mkv': film }, /title and year could not be read/],
    ['disagreeing names', 'Toy.Story.2.1999.1080p', { 'Toy.Story.2.1999.1080p/Toy.Story.3.2010.1080p.mkv': film }, /says/],
    ['two parts', 'Film.2001.DVDRip', { 'Film.2001.DVDRip/CD1.avi': film, 'Film.2001.DVDRip/CD2.avi': film.slice(0, 2900) }, /More than one large video/],
    ['a season with no episode numbers', 'Some Show Season 2 1080p', { 'Some Show Season 2 1080p/Episode One.mkv': film }, /title and year/],
    ['empty video', 'Empty.2001.1080p', { 'Empty.2001.1080p/Empty.2001.1080p.mkv': '' }, /Empty file/],
  ]
  for (const [label, name, files, reason] of cases) {
    const context = await setup()
    await addTorrent(context, HASH, name, files)
    const result = await context.make().importTorrent(HASH)
    assert.equal(result.result, 'review', label)
    assert.match(result.reason, reason, label)
    assert.deepEqual((await readdir(context.library)).filter((entry) => !entry.startsWith('.')), [], `${label}: nothing published`)
    assert.equal((await context.make().importTorrent(HASH)).result, 'unchanged', `${label}: not reprocessed`)
  }
  const unreadable = await setup({ probe: async () => ({ ok: false, reason: 'ffprobe could not read it' }) })
  await addTorrent(unreadable, HASH, 'Broken.2001.1080p', { 'Broken.2001.1080p/Broken.2001.1080p.mkv': film })
  assert.match((await unreadable.make().importTorrent(HASH)).reason, /ffprobe could not read it/)
  const short = await setup({ probe: async () => ({ ok: true, duration: 90 }) })
  await addTorrent(short, HASH, 'Short.2001.1080p', { 'Short.2001.1080p/Short.2001.1080p.mkv': film })
  assert.match((await short.make().importTorrent(HASH)).reason, /not a film/)
  // Without ffprobe nothing is published or sent to review: it waits until ffprobe is installed.
  const missing = await setup({ probe: async () => ({ ok: false, reason: 'ffprobe is not installed' }) })
  await addTorrent(missing, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  assert.equal((await missing.make().importTorrent(HASH)).result, 'not-ready')
})

test('files outside staging, links out of it and unfinished torrents are refused', async () => {
  const context = await setup()
  const outside = join(context.root, 'outside.mkv')
  await writeFile(outside, film)
  await mkdir(join(context.staging, 'Sneaky.2001.1080p'))
  await symlink(outside, join(context.staging, 'Sneaky.2001.1080p', 'Sneaky.2001.1080p.mkv'))
  context.torrents[HASH] = { info: { name: 'Sneaky.2001.1080p', category: 'tomifin-family', state: 'stalledUP', progress: 1, amount_left: 0, save_path: context.staging }, files: [{ name: 'Sneaky.2001.1080p/Sneaky.2001.1080p.mkv', size: 3000, progress: 1, priority: 1 }] }
  const linked = await context.make().importTorrent(HASH)
  assert.equal(linked.result, 'review')
  assert.match(linked.reason, /outside the staging folder/)
  assert.deepEqual(await readdir(join(context.library, '.review', HASH)), ['reason.json'], 'the outside file is not linked into review')

  const escape = await setup()
  escape.torrents[HASH] = { info: { name: 'Escape.2001.1080p', category: 'tomifin-family', state: 'stalledUP', progress: 1, amount_left: 0, save_path: escape.staging }, files: [{ name: '../../etc/passwd.mkv', size: 10, progress: 1, priority: 1 }] }
  assert.match((await escape.make().importTorrent(HASH)).reason, /Unsafe file name/)

  const elsewhere = await setup()
  await addTorrent(elsewhere, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film }, { save_path: elsewhere.library })
  assert.match((await elsewhere.make().importTorrent(HASH)).reason, /saved outside/)

  for (const [label, extra, files] of [['downloading', { state: 'downloading', progress: 0.5, amount_left: 10 }, null], ['file not done', {}, [{ name: 'Sintel.2010.720p/Sintel.2010.720p.mkv', size: 3000, progress: 0.9, priority: 1 }]], ['size mismatch', {}, [{ name: 'Sintel.2010.720p/Sintel.2010.720p.mkv', size: 9999, progress: 1, priority: 1 }]], ['partial file', {}, [{ name: 'Sintel.2010.720p/Sintel.2010.720p.mkv.!qB', size: 3000, progress: 1, priority: 1 }]]]) {
    const waiting = await setup()
    await addTorrent(waiting, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film, 'Sintel.2010.720p/Sintel.2010.720p.mkv.!qB': film }, extra)
    if (files) waiting.torrents[HASH].files = files
    const result = await waiting.make().importTorrent(HASH)
    assert.ok(['not-ready', 'review'].includes(result.result), label)
    assert.deepEqual((await readdir(waiting.library)).filter((entry) => !entry.startsWith('.')), [], `${label}: nothing published`)
  }
  const other = await setup()
  await addTorrent(other, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film }, { category: 'tomify' })
  assert.equal((await other.make().importTorrent(HASH)).result, 'skipped')
  await assert.rejects(other.make().importTorrent('../../etc'), /Not a torrent info hash/)
})

test('the queue is drained, odd entries are removed, and a scan picks up what the hook missed', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  await addTorrent(context, OTHER, 'Big.Buck.Bunny.2008.1080p', { 'Big.Buck.Bunny.2008.1080p/Big.Buck.Bunny.2008.1080p.mp4': film })
  const queue = join(context.staging, '.tomifin-import-queue')
  await mkdir(queue)
  await writeFile(join(queue, HASH), '')
  await writeFile(join(queue, 'not-a-hash; rm -rf ~'), '')
  const drained = await context.make().drainQueue()
  assert.deepEqual(drained.map((entry) => entry.result), ['published'])
  assert.deepEqual(await readdir(queue), [])
  const scanned = await context.make().scan()
  assert.deepEqual(scanned.map((entry) => [entry.hash, entry.result]), [[OTHER, 'published']])
  assert.deepEqual(await context.make().scan(), [])
  assert.deepEqual((await readdir(context.library)).filter((entry) => !entry.startsWith('.')).sort(), ['Big Buck Bunny (2008)', 'Sintel (2010)'])
})

test('a queued torrent that is not ready yet is retried in the same run, and an unreadable queue is an error', async () => {
  const context = await setup()
  await addTorrent(context, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film }, { state: 'moving' })
  const queue = join(context.staging, '.tomifin-import-queue')
  await mkdir(queue)
  await writeFile(join(queue, HASH), '')
  let waits = 0
  const importer = context.make({ queueRetries: 3, queueRetryMs: 1 })
  const original = context.torrents[HASH].info
  const drained = importer.drainQueue()
  // qBittorrent finishes moving the torrent while the importer waits.
  const timer = setInterval(() => { waits += 1; if (waits === 2) original.state = 'stalledUP' }, 1)
  const results = await drained
  clearInterval(timer)
  assert.deepEqual(results.map((entry) => entry.result), ['published'])
  assert.deepEqual(await readdir(queue), [])

  const stuck = await setup()
  await addTorrent(stuck, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film }, { state: 'moving' })
  await mkdir(join(stuck.staging, '.tomifin-import-queue'))
  await writeFile(join(stuck.staging, '.tomifin-import-queue', HASH), '')
  assert.deepEqual((await stuck.make({ queueRetries: 2, queueRetryMs: 1 }).drainQueue()).map((entry) => entry.result), ['not-ready'])
  assert.deepEqual(await readdir(join(stuck.staging, '.tomifin-import-queue')), [], 'removed after the retries; the scan picks it up later')

  const broken = await setup()
  await writeFile(join(broken.staging, '.tomifin-import-queue'), 'not a folder')
  await assert.rejects(broken.make().drainQueue(), /cannot be read/)
  assert.deepEqual(await (await setup()).make().drainQueue(), [], 'no queue folder yet is fine')
})

test('the command runs when started through a symlinked release folder, as /opt/tomify/current is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'family-cli-'))
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'current'))
  const run = spawnSync(process.execPath, [join(root, 'current', 'family-import.mjs'), '--scan', '--dry-run'], { env: { PATH: process.env.PATH, TOMIFIN_IMPORT_LIBRARY: join(root, 'missing') }, encoding: 'utf8' })
  // It must reach main() and say why it stopped, never exit silently.
  assert.equal(run.status, 1)
  assert.match(run.stderr, /"result":"failed"/)
})

test('the importer never asks for setuid or setgid modes, which its unit forbids (RestrictSUIDSGID)', async () => {
  const source = await readFile(new URL('./family-import.mjs', import.meta.url), 'utf8')
  const modes = [...source.matchAll(/mode:\s*0o([0-7]+)/g)].map((match) => Number.parseInt(match[1], 8))
  assert.ok(modes.length > 0)
  for (const mode of modes) assert.equal(mode & 0o6000, 0, `mode 0o${mode.toString(8)} carries setuid/setgid`)
  const unit = await readFile(new URL('./family-import/tomifin-family-import.service.example', import.meta.url), 'utf8')
  assert.match(unit, /^RestrictSUIDSGID=yes$/m)
})

test('the qBittorrent hook queues only Family torrents with a valid hash', async () => {
  const queue = join(await mkdtemp(join(tmpdir(), 'family-hook-')), 'queue')
  const hook = new URL('./family-import/tomifin-family-import-hook.sh', import.meta.url).pathname
  const run = (...args) => execFileSync('sh', [hook, ...args], { env: { PATH: process.env.PATH, TOMIFIN_IMPORT_QUEUE: queue } })
  run(HASH, 'tomifin-family')
  run(OTHER, 'tomify')
  run('$(touch /tmp/pwned)', 'tomifin-family')
  run('../../x', 'tomifin-family')
  run('A'.repeat(40), 'tomifin-family')
  run('c'.repeat(64), 'tomifin-family')
  run()
  assert.deepEqual((await readdir(queue)).sort(), [HASH, 'c'.repeat(64)])
})

// ---------------------------------------------------------------------------------------------------------------
// TV

const episode = (n) => `episode ${n} `.repeat(200)
const tvFolder = (context, ...parts) => join(context.library, 'TV', ...parts)
const visible = async (context) => (await readdir(context.library)).filter((entry) => !entry.startsWith('.'))

test('episode and series names are read conservatively', () => {
  assert.deepEqual(parseEpisodeName('MobLand.S02E01.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv'), { series: { title: 'MobLand', year: null, key: 'mobland', name: 'MobLand' }, season: 2, episodes: [1], title: null })
  assert.equal(parseEpisodeName('mobland.s02e04.mkv').season, 2)
  assert.equal(parseEpisodeName('Show - S01E01 - Pilot.mkv').title, 'Pilot')
  assert.equal(parseEpisodeName('Bluey.S03E05.Housework.1080p.WEB.h264-GRP.mkv').title, 'Housework')
  // A bare word after the marker may be a release group: it is not taken as a title.
  assert.equal(parseEpisodeName('Show.S01E01.GRP.mkv').title, null)
  assert.equal(parseEpisodeName('Show.S01E01.PROPER.REPACK.720p.mkv').title, null)
  assert.equal(parseEpisodeName('Show.S01E01.German.DL.720p.mkv').title, null)
  assert.equal(parseEpisodeName('Doctor.Who.2005.S01E01.Rose.720p.BluRay.mkv').series.name, 'Doctor Who (2005)')
  assert.deepEqual(parseEpisodeName('Show.S01E01E02.720p.mkv').episodes, [1, 2])
  assert.deepEqual(parseEpisodeName('Show.S01E01-E02.720p.mkv').episodes, [1, 2])
  assert.deepEqual(parseEpisodeName('Show.S01E01E03.mkv'), { invalid: true })
  assert.deepEqual(parseEpisodeName('Show.S01E01.S01E02.mkv'), { invalid: true })
  assert.equal(parseEpisodeName('S02E03.mkv').series, null)
  assert.equal(parseEpisodeName('Toy.Story.2.1999.1080p.mkv'), null)
  assert.deepEqual(parseSeriesRelease('MobLand (Season 2) WEB-DL 1080p'), { series: { title: 'MobLand', year: null, key: 'mobland', name: 'MobLand' }, season: 2 })
  assert.equal(parseSeriesRelease('Show S01-S03 Complete 1080p').season, null)
  assert.equal(parseSeriesRelease('The Office').series, null)
})

test('the MobLand season pack is published as TV episodes, not sent to review as films', async () => {
  const context = await setup()
  const name = 'MobLand (Season 2) WEB-DL 1080p'
  const files = Object.fromEntries([1, 2, 3, 4].map((n) => [`${name}/MobLand.S02E0${n}.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv`, episode(n)]))
  files[`${name}/Sample/MobLand.S02E01.sample.mkv`] = 'sample'
  files[`${name}/MobLand.nfo`] = 'nfo'
  await addTorrent(context, HASH, name, files)
  const before = execFileSync('find', [context.staging, '-printf', '%p %s\n']).toString()
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.equal(result.series, 'MobLand')
  const season = tvFolder(context, 'MobLand', 'Season 02')
  assert.deepEqual((await readdir(season)).sort(), ['MobLand - S02E01.mkv', 'MobLand - S02E02.mkv', 'MobLand - S02E03.mkv', 'MobLand - S02E04.mkv'])
  for (const n of [1, 2, 3, 4]) {
    const source = await stat(join(context.staging, `${name}/MobLand.S02E0${n}.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv`))
    const published = await stat(join(season, `MobLand - S02E0${n}.mkv`))
    assert.deepEqual([published.ino, published.nlink], [source.ino, 2], `episode ${n} is a hardlink`)
  }
  assert.equal(execFileSync('find', [context.staging, '-printf', '%p %s\n']).toString(), before, 'the download is untouched')
  assert.deepEqual(await visible(context), ['TV'])
  assert.equal(await lstat(join(context.library, '.review')).then(() => true, () => false), false)
  assert.equal((await context.make().importTorrent(HASH)).result, 'unchanged', 'idempotent')
})

test('a single episode keeps a clear episode title, and a dry run writes nothing', async () => {
  const context = await setup()
  const name = 'Bluey.S03E05.Housework.1080p.WEB.h264-GRP'
  await addTorrent(context, HASH, name, { [`${name}/${name}.mkv`]: episode(5) })
  const dry = await context.make({ dryRun: true }).importTorrent(HASH)
  assert.equal(dry.result, 'would-publish')
  assert.deepEqual(dry.published, [tvFolder(context, 'Bluey', 'Season 03', 'Bluey - S03E05 - Housework.mkv')])
  assert.deepEqual(await visible(context), [])
  const result = await context.make({ tvDir: 'Shows' }).importTorrent(HASH)
  assert.deepEqual(result.published, [join(context.library, 'Shows', 'Bluey', 'Season 03', 'Bluey - S03E05 - Housework.mkv')])
  assert.throws(() => context.make({ tvDir: '../TV' }), /one plain folder name/)
  assert.throws(() => context.make({ tvDir: 'Movies', moviesDir: 'Movies' }), /separate from the films folder/)
})

test('a pack of several seasons is published when every name agrees, and refused when a season does not', async () => {
  const context = await setup()
  const name = 'Show.S01-S02.1080p.BluRay.x264'
  await addTorrent(context, HASH, name, {
    [`${name}/Season 1/Show.S01E01.1080p.BluRay.x264.mkv`]: episode(1),
    [`${name}/Season 1/Show.S01E02.1080p.BluRay.x264.mkv`]: episode(2),
    [`${name}/Season 2/Show.S02E01E02.1080p.BluRay.x264.mkv`]: episode(3),
  })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual(result.seasons, [1, 2])
  assert.deepEqual((await readdir(tvFolder(context, 'Show', 'Season 01'))).sort(), ['Show - S01E01.mkv', 'Show - S01E02.mkv'])
  assert.deepEqual(await readdir(tvFolder(context, 'Show', 'Season 02')), ['Show - S02E01-E02.mkv'])

  for (const [label, torrentName, files] of [
    ['download names another season', 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E01.mkv': episode(1), 'Show.S01.1080p/Show.S02E01.mkv': episode(2) }],
    ['folder names another season', 'Show.Complete.1080p', { 'Show.Complete.1080p/Season 1/Show.S02E01.mkv': episode(1) }],
  ]) {
    const refused = await setup()
    await addTorrent(refused, HASH, torrentName, files)
    const outcome = await refused.make().importTorrent(HASH)
    assert.equal(outcome.result, 'review', label)
    assert.equal(outcome.code, 'season-mismatch', label)
    assert.deepEqual(await visible(refused), [], `${label}: nothing published`)
  }
})

test('two different files claiming one episode go to review; byte-identical copies are published once', async () => {
  const different = await setup()
  await addTorrent(different, HASH, 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E02.1080p.mkv': episode(2), 'Show.S01.1080p/Extra/Show.S01E02.720p.mkv': episode(9), 'Show.S01.1080p/Show.S01E01.mkv': episode(1) })
  const refused = await different.make().importTorrent(HASH)
  assert.equal(refused.result, 'review')
  assert.equal(refused.code, 'duplicate-episode')
  assert.match(refused.reason, /S01E02/)
  assert.deepEqual(await visible(different), [])
  const review = JSON.parse(await readFile(join(different.library, '.review', HASH, 'reason.json'), 'utf8'))
  assert.equal(review.code, 'duplicate-episode')

  const overlap = await setup()
  await addTorrent(overlap, HASH, 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E01E02.mkv': episode(1), 'Show.S01.1080p/Show.S01E02.mkv': episode(2) })
  assert.equal((await overlap.make().importTorrent(HASH)).code, 'duplicate-episode')

  const identical = await setup()
  await addTorrent(identical, HASH, 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E02.1080p.mkv': episode(2), 'Show.S01.1080p/Copy/Show.S01E02.1080p.mkv': episode(2) })
  const published = await identical.make().importTorrent(HASH)
  assert.equal(published.result, 'published', published.reason)
  assert.deepEqual(await readdir(tvFolder(identical, 'Show', 'Season 01')), ['Show - S01E02.mkv'])
})

test('conflicting series names, mixed content and unclear numbers are not guessed', async () => {
  const cases = [
    ['files disagree', 'Pack.S01.1080p', { 'Pack.S01.1080p/Show.One.S01E01.mkv': episode(1), 'Pack.S01.1080p/Show.Two.S01E02.mkv': episode(2) }, 'ambiguous-series'],
    ['download and files disagree', 'Foo.S01.1080p', { 'Foo.S01.1080p/Bar.S01E01.mkv': episode(1) }, 'ambiguous-series'],
    ['different years', 'Show.2005.S01.1080p', { 'Show.2005.S01.1080p/Show.2010.S01E01.mkv': episode(1) }, 'ambiguous-series'],
    ['no series anywhere', 'Season 1', { 'Season 1/S01E01.mkv': episode(1) }, 'ambiguous-series'],
    ['an extra video', 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E01.mkv': episode(1), 'Show.S01.1080p/Behind the scenes.mkv': episode(7) }, 'mixed-content'],
    ['an unclear episode number', 'Show.S01.1080p', { 'Show.S01.1080p/Show.S01E01E04.mkv': episode(1) }, 'ambiguous-episode'],
  ]
  for (const [label, name, files, code] of cases) {
    const context = await setup()
    await addTorrent(context, HASH, name, files)
    const result = await context.make().importTorrent(HASH)
    assert.equal(result.result, 'review', label)
    assert.equal(result.code, code, label)
    assert.deepEqual(await visible(context), [], `${label}: nothing published`)
  }
  // Files that do not name the series take it from the download's name.
  const unnamed = await setup()
  await addTorrent(unnamed, HASH, 'MobLand (Season 2) WEB-DL 1080p', { 'MobLand (Season 2) WEB-DL 1080p/S02E01.mkv': episode(1) })
  assert.deepEqual((await unnamed.make().importTorrent(HASH)).published, [tvFolder(unnamed, 'MobLand', 'Season 02', 'MobLand - S02E01.mkv')])
  // A short video is not an episode.
  const short = await setup({ probe: async () => ({ ok: true, duration: 30 }) })
  await addTorrent(short, HASH, 'Show.S01E01.720p', { 'Show.S01E01.720p.mkv': episode(1) })
  assert.equal((await short.make().importTorrent(HASH)).code, 'too-short')
})

test('episode subtitles are named after their episode, with language, forced and SDH suffixes', async () => {
  const context = await setup()
  const name = 'Show.S01.1080p.WEB-DL'
  await addTorrent(context, HASH, name, {
    [`${name}/Show.S01E01.1080p.WEB-DL.mkv`]: episode(1),
    [`${name}/Show.S01E02.1080p.WEB-DL.mkv`]: episode(2),
    [`${name}/Subs/Show.S01E01.1080p.WEB-DL/2_English.srt`]: 'english one',
    [`${name}/Subs/Show.S01E01.1080p.WEB-DL/3_English.SDH.srt`]: 'english sdh',
    [`${name}/Show.S01E02.1080p.WEB-DL.eng.forced.srt`]: 'forced two',
    [`${name}/Show.S01E02.1080p.WEB-DL.fr.srt`]: 'french two',
    [`${name}/Extras.srt`]: 'no episode',
  })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual((await readdir(tvFolder(context, 'Show', 'Season 01'))).sort(), ['Show - S01E01.en.sdh.srt', 'Show - S01E01.en.srt', 'Show - S01E01.mkv', 'Show - S01E02.en.forced.srt', 'Show - S01E02.fr.srt', 'Show - S01E02.mkv'])
  assert.equal(await readFile(tvFolder(context, 'Show', 'Season 01', 'Show - S01E02.en.forced.srt'), 'utf8'), 'forced two')
  assert.deepEqual(result.skippedSubtitles, [`${name}/Extras.srt`])
})

test('an episode already in the library is recognised, and a different one is never overwritten', async () => {
  const context = await setup()
  const name = 'Show.S01.1080p'
  await addTorrent(context, HASH, name, { [`${name}/Show.S01E01.mkv`]: episode(1), [`${name}/Show.S01E02.mkv`]: episode(2) })
  await mkdir(tvFolder(context, 'Show', 'Season 01'), { recursive: true })
  // S01E01 already there with the same content (copied by hand): kept, and S01E02 is added beside it.
  await writeFile(tvFolder(context, 'Show', 'Season 01', 'Show - S01E01.mkv'), episode(1))
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual((await readdir(tvFolder(context, 'Show', 'Season 01'))).sort(), ['Show - S01E01.mkv', 'Show - S01E02.mkv'])
  assert.equal((await stat(tvFolder(context, 'Show', 'Season 01', 'Show - S01E01.mkv'))).nlink, 1, 'the existing file is left alone')
  await writeFile(join(context.stateDir, `${HASH}.json`), '{}')
  assert.equal((await context.make().importTorrent(HASH)).result, 'already-imported')

  const conflict = await setup()
  await addTorrent(conflict, HASH, name, { [`${name}/Show.S01E01.mkv`]: episode(1), [`${name}/Show.S01E02.mkv`]: episode(2) })
  await mkdir(tvFolder(conflict, 'Show', 'Season 01'), { recursive: true })
  await writeFile(tvFolder(conflict, 'Show', 'Season 01', 'Show - S01E02.mkv'), 'something else')
  const refused = await conflict.make().importTorrent(HASH)
  assert.equal(refused.result, 'review')
  assert.equal(refused.code, 'conflict')
  assert.deepEqual(await readdir(tvFolder(conflict, 'Show', 'Season 01')), ['Show - S01E02.mkv'], 'nothing else published, nothing replaced')
  assert.equal(await readFile(tvFolder(conflict, 'Show', 'Season 01', 'Show - S01E02.mkv'), 'utf8'), 'something else')

  // A series folder that is a link out of the library is refused.
  const linked = await setup()
  await addTorrent(linked, HASH, name, { [`${name}/Show.S01E01.mkv`]: episode(1) })
  await mkdir(join(linked.library, 'TV'))
  await mkdir(join(linked.root, 'elsewhere'))
  await symlink(join(linked.root, 'elsewhere'), join(linked.library, 'TV', 'Show'))
  assert.equal((await linked.make().importTorrent(HASH)).code, 'unsafe-path')
  assert.deepEqual(await readdir(join(linked.root, 'elsewhere')), [])
})

test('films still go to the films folder beside TV, and ambiguous film packs still go to review', async () => {
  const context = await setup()
  await mkdir(join(context.library, 'Movies'))
  await addTorrent(context, HASH, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  await addTorrent(context, OTHER, 'Two.Films.2001.DVDRip', { 'Two.Films.2001.DVDRip/CD1.avi': film, 'Two.Films.2001.DVDRip/CD2.avi': film })
  const importer = context.make({ moviesDir: 'Movies' })
  assert.deepEqual((await importer.importTorrent(HASH)).published, [join(context.library, 'Movies', 'Sintel (2010)', 'Sintel (2010).mkv')])
  assert.equal((await importer.importTorrent(OTHER)).code, 'ambiguous-video')
  assert.deepEqual(await visible(context), ['Movies'])
})

// ---------------------------------------------------------------------------------------------------------------
// Usenet downloads (importDirectory)

const JOB = 'usenet-00000000-0000-4000-8000-000000000001'

async function usenetSetup(options) {
  const context = await setup(options)
  const completed = join(context.root, 'usenet', 'tomifin-family')
  await mkdir(completed, { recursive: true })
  return { ...context, usenet: join(context.root, 'usenet'), completed }
}

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content)
  }
}

test('a finished Usenet season pack is imported with verified copies, leaving SABnzbd\'s files as they were', async () => {
  const context = await usenetSetup()
  const folder = join(context.completed, 'tomifin-00000000-0000-4000-8000-000000000001')
  await writeTree(folder, { 'MobLand.S02E01.1080p.WEB-DL.mkv': episode(1), 'MobLand.S02E02.1080p.WEB-DL.mkv': episode(2), 'MobLand.S02E01.1080p.WEB-DL.en.srt': 'subs', 'MobLand.nzb.par2': 'par2' })
  const before = execFileSync('find', [folder, '-printf', '%p %i %s\n']).toString()
  const result = await context.make().importDirectory({ key: JOB, name: 'MobLand (Season 2) WEB-DL 1080p', root: folder, allowedRoot: context.usenet, mode: 'copy' })
  assert.equal(result.result, 'published', result.reason)
  assert.equal(result.key, JOB)
  const season = tvFolder(context, 'MobLand', 'Season 02')
  assert.deepEqual((await readdir(season)).sort(), ['MobLand - S02E01.en.srt', 'MobLand - S02E01.mkv', 'MobLand - S02E02.mkv'])
  const copy = await stat(join(season, 'MobLand - S02E01.mkv'))
  const original = await stat(join(folder, 'MobLand.S02E01.1080p.WEB-DL.mkv'))
  assert.notEqual(copy.ino, original.ino, 'a copy, not a link')
  assert.equal(await readFile(join(season, 'MobLand - S02E01.mkv'), 'utf8'), episode(1))
  assert.equal(execFileSync('find', [folder, '-printf', '%p %i %s\n']).toString(), before, 'SABnzbd\'s output is untouched')
  assert.deepEqual((await readdir(join(context.library, '.publishing'))).sort(), ['.ignore'], 'no temporary copies left behind')
  assert.equal((await context.make().importDirectory({ key: JOB, name: 'x', root: folder, allowedRoot: context.usenet, mode: 'copy' })).result, 'unchanged')
})

test('a finished Usenet film is hardlinked when it can be, and copied otherwise', async () => {
  const context = await usenetSetup()
  const folder = join(context.completed, 'tomifin-job')
  await writeTree(folder, { 'Sintel.2010.1080p.BluRay.x264.mkv': film })
  const result = await context.make().importDirectory({ key: JOB, name: 'Sintel.2010.1080p.BluRay.x264', root: folder, allowedRoot: context.usenet, mode: 'auto' })
  assert.equal(result.result, 'published', result.reason)
  const published = await stat(join(context.library, 'Sintel (2010)', 'Sintel (2010).mkv'))
  assert.equal(published.ino, (await stat(join(folder, 'Sintel.2010.1080p.BluRay.x264.mkv'))).ino, 'same filesystem: a hardlink')

  const copied = await usenetSetup()
  const other = join(copied.completed, 'tomifin-job')
  await writeTree(other, { 'Sintel.2010.1080p.BluRay.x264.mkv': film })
  assert.equal((await copied.make().importDirectory({ key: JOB, name: 'Sintel.2010.1080p.BluRay.x264', root: other, allowedRoot: copied.usenet, mode: 'copy' })).result, 'published')
  assert.equal((await stat(join(copied.library, 'Sintel (2010)', 'Sintel (2010).mkv'))).nlink, 1)
})

test('unsafe or unfinished Usenet output goes to review with a reason code, and nothing is published', async () => {
  const cases = [
    ['symlink', async (folder, context) => { await writeFile(join(context.root, 'outside.mkv'), film); await symlink(join(context.root, 'outside.mkv'), join(folder, 'Sintel.2010.1080p.mkv')) }, 'unsafe-symlink'],
    ['archives left', async (folder) => writeTree(folder, { 'Sintel.2010.1080p.mkv': film, 'sintel.part01.rar': 'rar' }), 'archives-remain'],
    ['only archives', async (folder) => writeTree(folder, { 'sintel.rar': 'rar', 'sintel.r00': 'rar' }), 'archives-remain'],
    ['FIFO', async (folder) => { await writeTree(folder, { 'Sintel.2010.1080p.mkv': film }); execFileSync('mkfifo', [join(folder, 'pipe')]) }, 'special-file'],
    ['episode collision', async (folder) => writeTree(folder, { 'Show.S01E01.mkv': episode(1), 'a/Show.S01E01.mkv': episode(2) }), 'duplicate-episode'],
  ]
  for (const [label, prepare, code] of cases) {
    const context = await usenetSetup()
    const folder = join(context.completed, 'tomifin-job')
    await mkdir(folder)
    await prepare(folder, context)
    const result = await context.make().importDirectory({ key: JOB, name: code === 'duplicate-episode' ? 'Show.S01.1080p' : 'Sintel.2010.1080p', root: folder, allowedRoot: context.usenet, mode: 'copy' })
    assert.equal(result.result, 'review', label)
    assert.equal(result.code, code, label)
    assert.deepEqual(await visible(context), [], `${label}: nothing published`)
    assert.equal(JSON.parse(await readFile(join(context.library, '.review', JOB, 'reason.json'), 'utf8')).code, code)
  }
  const outside = await usenetSetup()
  await writeTree(join(outside.root, 'elsewhere'), { 'Sintel.2010.1080p.mkv': film })
  assert.equal((await outside.make().importDirectory({ key: JOB, name: 'x', root: join(outside.root, 'elsewhere'), allowedRoot: outside.usenet })).code, 'unsafe-path')
  await assert.rejects(outside.make().importDirectory({ key: '../../etc', name: 'x', root: outside.completed, allowedRoot: outside.usenet }), /Not a Usenet download/)
})
