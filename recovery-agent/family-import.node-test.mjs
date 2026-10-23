import test from 'node:test'
import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFamilyImporter, filmIdentity, parseFilmName, subtitleLanguage } from './family-import.mjs'

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
    ['TV', 'Show.S01E02.720p.HDTV', { 'Show.S01E02.720p.HDTV.mkv': film }, /title and year/],
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
