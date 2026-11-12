import test from 'node:test'
import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFamilyImporter, filmIdentity, usenetReleaseName, parseEpisodeName, parseFilmName, parseSeriesRelease, refreshJellyfinAfterImport, subtitleLanguage } from './family-import.mjs'
import { createJellyfinFolderRefresh } from './jellyfin.mjs'

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
  for (const name of ['Toy.Story.1080p.BluRay.x264', 'Breaking.Bad.S01E01.720p.HDTV', 'Some Show Season 2 1080p', '1999', '1080p.2019.BluRay']) {
    assert.equal(parseFilmName(name), null, name)
  }
  assert.equal(filmIdentity('Toy.Story.2.1999.1080p', 'Toy.Story.2.1999.1080p.mkv').identity.name, 'Toy Story 2 (1999)')
  assert.match(filmIdentity('Toy.Story.2.1999.1080p', 'Toy.Story.3.2010.1080p.mkv').reason, /says/)
})

test('whatever follows the release year is ignored, not interpreted', () => {
  for (const name of [
    'Sintel 2010 WEB-DLRip 1 46Gb D MegaPeer',
    'Sintel.2010.Whatever.Words.Q7.zz-Top.~42~.mkv',
    'Sintel 2010 Directors Cut Part Two Final',
    'Sintel (2010) Dub Rus Eng 700MB by Somebody',
    'Sintel (2010)',
    'Sintel 2010',
  ]) assert.deepEqual(parseFilmName(name), { title: 'Sintel', year: 2010, name: 'Sintel (2010)' }, name)
  // A title may hold a number; an impossible year is a title word, as in "Blade Runner 2049".
  assert.equal(parseFilmName('Blade.Runner.2049.2017.Anything.Else')?.name, 'Blade Runner 2049 (2017)')
  assert.equal(parseFilmName('Tenacious.D.in.The.Pick.of.Destiny.2006.1080p.BluRay.x264')?.name, 'Tenacious D in The Pick of Destiny (2006)')
  for (const name of [
    // A TV episode or season.
    'Sintel.S01E02.2010.1080p', 'Sintel 2010 Season 1 1080p', 'Sintel.2010.1x02.720p',
    // More than one plausible year: two films, or a re-release.
    'Sintel 2010 Tears of Steel 2012 1080p', 'Sintel.2010.Remastered.2021.1080p', 'Sintel (2010) + Tears of Steel (2012)', 'Wonder.Woman.1984.2020.1080p',
    // No credible title or year.
    'Sintel 1080p WEB-DL', 'Sintel 2099 1080p', 'Sintel 1850 1080p', '2010 1080p', '(2010) 1080p',
    // A release tag before the year, so where the title ends is not clear.
    'Sintel 1080p 2010', 'Sintel.WEB-DL.2010', 'Sintel x264 (2010)', 'Sintel Remastered 2010',
    // Not a safe folder name.
    'Sin:tel 2010 1080p', 'Sin"tel (2010)',
  ]) assert.equal(parseFilmName(name), null, name)
  // The torrent and its main video are read separately, and both must name the same film.
  assert.equal(filmIdentity('Sintel 2010 WEB-DLRip D MegaPeer', 'Sintel.2010.1080p.x264-Group.mkv').identity.name, 'Sintel (2010)')
  for (const [torrent, file] of [
    ['Sintel 2010 1080p', 'Tears.of.Steel.2012.1080p.mkv'],
    ['Sintel 2010 1080p', 'Sintel.2011.1080p.mkv'],
    ['Sintel 2010 1080p', 'Sintel.2.2010.1080p.mkv'],
    ['Sintel 2010 1080p', 'movie.mkv'],
    ['Some Pack of Films', 'Sintel.2010.720p.mkv'],
    ['Sintel 2010 Tears of Steel 2012', 'Sintel.2010.720p.mkv'],
    ['Sintel 2010 1080p', 'Sintel.S01E01.2010.mkv'],
  ]) assert.equal(filmIdentity(torrent, file).identity, null, `${torrent} / ${file}`)
  assert.match(filmIdentity('Sintel 2010 1080p', 'movie.mkv').reason, /torrent name says "Sintel \(2010\)" but the title and year could not be read from the video file name/)
  assert.match(filmIdentity('Some Pack of Films', 'Sintel.2010.720p.mkv').reason, /video file says "Sintel \(2010\)" but the title and year could not be read from the torrent name/)
})

const IRON_GIANT = 'The Iron Giant (1999) DIRECTOR CUT REPACK 1080p BluRay 5 1-LAMA'
const IRON_GIANT_FILE = 'The.Iron.Giant.1999.DIRECTOR.CUT.REPACK.1080p.BluRay.x264.AAC5.1-LAMA.mp4'

test('an explicit Title (Year) prefix, and its dotted form, are read whatever release words follow', () => {
  for (const name of [IRON_GIANT, IRON_GIANT_FILE, 'The.Iron.Giant.1999.Directors.Cut.1080p.BluRay.x264-LAMA', "The Iron Giant 1999 Director's Cut 1080p BluRay x264-LAMA"]) {
    assert.deepEqual(parseFilmName(name), { title: 'The Iron Giant', year: 1999, name: 'The Iron Giant (1999)' }, name)
  }
  assert.equal(filmIdentity(IRON_GIANT, `${IRON_GIANT}/${IRON_GIANT_FILE}`).identity.name, 'The Iron Giant (1999)')
  assert.match(filmIdentity(IRON_GIANT, 'The.Iron.Giant.2.2001.1080p.BluRay.x264-LAMA.mp4').reason, /says/)
  // Still not guessed: two films, another year after the prefix, or a tag in the title.
  for (const name of [
    'Toy Story (1995) + Toy Story 2 (1999) 1080p',
    'Toy.Story.(1995).Toy.Story.2.(1999).1080p',
    'Dune (1984) Remastered 2021 1080p',
    '1080p (2019) BluRay',
    'The Iron Giant (1887) 1080p',
    'The Iron Giant REPACK (1999) 1080p',
  ]) assert.equal(parseFilmName(name), null, name)
})

const RONS = "Ron's Gone Wrong (2021) [1080p] [BluRay] [5.1]"
const RONS_FILE = 'Rons Gone Wrong (2021) [1080p] [BluRay] [5.1] [YTS.MX]/Rons.Gone.Wrong.2021.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4'

test('an apostrophe, straight, curly or left out, does not make the torrent and video disagree', () => {
  const rons = filmIdentity(RONS, RONS_FILE)
  assert.equal(rons.reason, null)
  assert.deepEqual(rons.identity, { title: "Ron's Gone Wrong", year: 2021, name: "Ron's Gone Wrong (2021)" })
  // The torrent's spelling is kept whichever side has the apostrophe.
  assert.equal(filmIdentity('Ron’s Gone Wrong (2021) 1080p', 'Ron\'s.Gone.Wrong.2021.1080p.mkv').identity.name, 'Ron’s Gone Wrong (2021)')
  assert.equal(filmIdentity("Ron's Gone Wrong (2021) 1080p", 'Ron’s.Gone.Wrong.2021.1080p.mkv').identity.name, "Ron's Gone Wrong (2021)")
  assert.equal(filmIdentity('Rons.Gone.Wrong.2021.1080p', 'Ron’s.Gone.Wrong.2021.1080p.mkv').identity.name, 'Rons Gone Wrong (2021)')
  assert.equal(filmIdentity("Schindler's List (1993) 1080p", 'Schindlers.List.1993.1080p.BluRay.x264.mkv').identity.name, "Schindler's List (1993)")
  // Different titles still disagree: another word, a missing word, other punctuation, a sequel number or another year.
  for (const [torrent, file] of [
    [RONS, 'Rons.Going.Wrong.2021.1080p.mp4'],
    [RONS, 'Ron.Gone.Wrong.2021.1080p.mp4'],
    [RONS, 'Gone.Wrong.2021.1080p.mp4'],
    [RONS, 'Rons.Gone.Wrong.2.2021.1080p.mp4'],
    [RONS, 'Rons.Gone.Wrong.2022.1080p.mp4'],
    ["Ocean's Eleven (2001) 1080p", "Ocean's.Twelve.2001.1080p.mkv"],
    ["It's a Wonderful Life (1946) 1080p", 'Its.A.Wonderful.Night.1946.1080p.mkv'],
    ['Spider-Man (2002) 1080p', 'Spider.Man.2002.1080p.mkv'],
    ['Se7en (1995) 1080p', 'Seven.1995.1080p.mkv'],
  ]) {
    const result = filmIdentity(torrent, file)
    assert.equal(result.identity, null, `${torrent} / ${file}`)
  }
  assert.match(filmIdentity(RONS, 'Rons.Going.Wrong.2021.1080p.mp4').reason, /says "Ron's Gone Wrong \(2021\)" but the video file says "Rons Going Wrong \(2021\)"/)
})

const NEXT_GEN = 'Next Gen 2018 WEB-DLRip 1 46Gb D MegaPeer'
const NEXT_GEN_FILE = 'Next.Gen.2018.WEB-DLRip.1.46Gb.D.MegaPeer/Next.Gen.2018.WEB-DLRip.1.46Gb.D.MegaPeer.avi'

test('the Next Gen release and its video name one film, whatever follows the year', () => {
  for (const name of [NEXT_GEN, basename(NEXT_GEN_FILE)]) {
    assert.deepEqual(parseFilmName(name), { title: 'Next Gen', year: 2018, name: 'Next Gen (2018)' }, name)
  }
  const nextGen = filmIdentity(NEXT_GEN, NEXT_GEN_FILE)
  assert.equal(nextGen.reason, null)
  assert.deepEqual(nextGen.identity, { title: 'Next Gen', year: 2018, name: 'Next Gen (2018)' })
  // A second year, a release tag before the year, or an episode is still refused.
  for (const name of [
    'Next Gen 2018 WEB-DLRip 1 46Gb D 2019 MegaPeer',
    'Next.Gen.2018.WEB-DLRip.1.46Gb.D.MegaPeer.2019.avi',
    'Next Gen WEB-DLRip 2018 1 46Gb D MegaPeer',
    'Next.Gen.S01E01.2018.WEB-DLRip.avi',
  ]) assert.equal(parseFilmName(name), null, name)
  // The torrent and its video must still agree.
  assert.match(filmIdentity(NEXT_GEN, 'Next.Gen.2.2018.WEB-DLRip.1.46Gb.D.MegaPeer.avi').reason, /says/)
  assert.match(filmIdentity(NEXT_GEN, 'Next.Gen.2019.WEB-DLRip.1.46Gb.D.MegaPeer.avi').reason, /says/)
  assert.equal(filmIdentity(NEXT_GEN, 'MegaPeer.avi').identity, null)
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

test('The Iron Giant Director\'s Cut repack is published as The Iron Giant (1999), not sent to review', async () => {
  const context = await setup()
  await addTorrent(context, HASH, IRON_GIANT, { [`${IRON_GIANT}/${IRON_GIANT_FILE}`]: film })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual(await readdir(join(context.library, 'The Iron Giant (1999)')), ['The Iron Giant (1999).mp4'])
  assert.deepEqual(await readdir(join(context.staging, IRON_GIANT)), [IRON_GIANT_FILE], 'the download is left as it was')
})

test('Ron\'s Gone Wrong, whose video file drops the apostrophe, is published under the torrent\'s spelling', async () => {
  const context = await setup()
  await addTorrent(context, HASH, RONS, { [RONS_FILE]: film })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual(await readdir(join(context.library, "Ron's Gone Wrong (2021)")), ["Ron's Gone Wrong (2021).mp4"])
  assert.equal(await lstat(join(context.library, '.review')).then(() => true, () => false), false, 'nothing sent to review')
  assert.deepEqual(await readdir(join(context.staging, dirname(RONS_FILE))), [basename(RONS_FILE)], 'the download is left as it was')
})

test('Next Gen, a WEB-DLRip with its size, dub marker and group after the year, is published as Next Gen (2018)', async () => {
  const context = await setup()
  await addTorrent(context, HASH, NEXT_GEN, { [NEXT_GEN_FILE]: film })
  const result = await context.make().importTorrent(HASH)
  assert.equal(result.result, 'published', result.reason)
  assert.deepEqual(await readdir(join(context.library, 'Next Gen (2018)')), ['Next Gen (2018).avi'])
  const published = await stat(join(context.library, 'Next Gen (2018)', 'Next Gen (2018).avi'))
  assert.equal(published.ino, (await stat(join(context.staging, NEXT_GEN_FILE))).ino, 'published as a hardlink')
  assert.equal(await lstat(join(context.library, '.review')).then(() => true, () => false), false, 'nothing sent to review')
  assert.deepEqual(await readdir(join(context.staging, dirname(NEXT_GEN_FILE))), [basename(NEXT_GEN_FILE)], 'the download is left as it was')
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
    ['a video of another year', NEXT_GEN, { 'Next.Gen.2018.WEB-DLRip/Next.Gen.2019.WEB-DLRip.1.46Gb.D.MegaPeer.avi': film }, /torrent name says "Next Gen \(2018\)" but the video file says "Next Gen \(2019\)"/],
    ['a video naming no film', NEXT_GEN, { 'Next.Gen.2018.WEB-DLRip/MegaPeer.avi': film }, /could not be read from the video file name/],
    ['a second year after the first', 'Next Gen 2018 WEB-DLRip 2019 MegaPeer', { 'Next Gen 2018 WEB-DLRip 2019 MegaPeer/Next.Gen.2018.WEB-DLRip.avi': film }, /could not be read from the torrent name/],
    ['two parts', 'Film.2001.DVDRip', { 'Film.2001.DVDRip/CD1.avi': film, 'Film.2001.DVDRip/CD2.avi': film.slice(0, 2900) }, /More than one large video/],
    ['a season with no episode numbers', 'Some Show Season 2 1080p', { 'Some Show Season 2 1080p/Episode One.mkv': film }, /title and year/],
    ['a pack of two films', 'Toy Story (1995) + Toy Story 2 (1999) 1080p', { 'Toy Story (1995) + Toy Story 2 (1999) 1080p/Toy.Story.1080p.mkv': film }, /title and year could not be read/],
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

test('NZBIndex subjects are read as the release they name', () => {
  assert.equal(usenetReleaseName('[01/58] - "The.Iron.Giant.1999.1080p.BluRay.x264-GRP.part01.rar" yEnc (1/101)'), 'The.Iron.Giant.1999.1080p.BluRay.x264-GRP')
  assert.equal(usenetReleaseName('(poster) [092/284] - "Sintel (2010).vol00+01.par2" yEnc'), 'Sintel (2010)')
  assert.equal(usenetReleaseName('[1/6] Sintel.2010.1080p yEnc'), 'Sintel.2010.1080p')
  assert.equal(usenetReleaseName('Sintel.2010.1080p.BluRay.x264'), 'Sintel.2010.1080p.BluRay.x264')
  assert.equal(usenetReleaseName('"Sintel.2010.1080p.mkv"'), 'Sintel.2010.1080p')
})

test('a Usenet film is published when only one of its release name and video name is readable, never when they differ', async () => {
  assert.equal(filmIdentity('Sintel.2010.1080p', 'tomifin-00000000-0000-4000-8000-000000000001.mkv').identity, null, 'torrents still need both')
  assert.equal(filmIdentity('Sintel.2010.1080p', 'a8f3c29d8e7b6a5c4d3e2f1a0b9c8d7e.mkv', { oneSideEnough: true }).identity.name, 'Sintel (2010)')
  assert.equal(filmIdentity('3f9a2c1d8e', 'Sintel.2010.1080p.mkv', { oneSideEnough: true }).identity.name, 'Sintel (2010)')
  assert.equal(filmIdentity('Sintel.2010.1080p', 'Big.Buck.Bunny.2008.mkv', { oneSideEnough: true }).identity, null)

  const renamed = await usenetSetup()
  const folder = join(renamed.completed, 'tomifin-00000000-0000-4000-8000-000000000001')
  await writeTree(folder, { 'tomifin-00000000-0000-4000-8000-000000000001.mkv': film })
  const result = await renamed.make().importDirectory({ key: JOB, name: '[01/58] - "Sintel.2010.1080p.BluRay.x264-GRP.part01.rar" yEnc (1/101)', root: folder, allowedRoot: renamed.usenet, mode: 'copy' })
  assert.equal(result.result, 'published', result.reason)
  assert.ok((await stat(join(renamed.library, 'Sintel (2010)', 'Sintel (2010).mkv'))).isFile())

  const scrambled = await usenetSetup()
  const other = join(scrambled.completed, 'tomifin-job')
  await writeTree(other, { 'Sintel.2010.1080p.BluRay.x264.mkv': film })
  assert.equal((await scrambled.make().importDirectory({ key: JOB, name: '[1/40] "a8f3c29d8e7b6a5c.part01.rar" yEnc', root: other, allowedRoot: scrambled.usenet, mode: 'copy' })).result, 'published')

  const differ = await usenetSetup()
  const third = join(differ.completed, 'tomifin-job')
  await writeTree(third, { 'Big.Buck.Bunny.2008.1080p.mkv': film })
  const held = await differ.make().importDirectory({ key: JOB, name: 'Sintel.2010.1080p', root: third, allowedRoot: differ.usenet, mode: 'copy' })
  assert.equal(held.result, 'review')
  assert.equal(held.code, 'ambiguous-name')
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

// One run of the importer as main() wires it: what onPublished collects is what Jellyfin is asked to scan.
async function familyRun(context, options = {}) {
  const published = []
  const importer = context.make({ moviesDir: 'Movies', onPublished: (entry) => published.push(...entry.published), ...options })
  return { importer, published }
}

test('only newly published downloads are handed on for a Jellyfin scan; dry runs, review and repeats are not', async () => {
  const context = await setup()
  await mkdir(join(context.library, 'Movies'))
  await addTorrent(context, HASH, 'Robots.2005.1080p.BluRay.x264', { 'Robots.2005.1080p.BluRay.x264/Robots.2005.1080p.BluRay.x264.mp4': film, 'Robots.2005.1080p.BluRay.x264/Robots.2005.en.srt': 'subtitle' })
  await addTorrent(context, OTHER, 'Some.Film.1080p', { 'Some.Film.1080p/Some.Film.1080p.mkv': film })

  const dry = await familyRun(context, { dryRun: true })
  assert.deepEqual((await dry.importer.scan()).map((entry) => entry.result).sort(), ['review', 'would-publish'])
  assert.deepEqual(dry.published, [], 'a dry run publishes nothing')

  const first = await familyRun(context)
  const results = await first.importer.scan()
  assert.deepEqual(results.map((entry) => [entry.hash, entry.result]).sort(), [[HASH, 'published'], [OTHER, 'review']])
  assert.deepEqual(first.published.sort(), [join(context.library, 'Movies', 'Robots (2005)', 'Robots (2005).en.srt'), join(context.library, 'Movies', 'Robots (2005)', 'Robots (2005).mp4')])

  const again = await familyRun(context)
  assert.equal((await again.importer.importTorrent(HASH)).result, 'unchanged')
  await writeFile(join(context.stateDir, `${HASH}.json`), '{}')
  assert.equal((await again.importer.importTorrent(HASH)).result, 'already-imported')
  assert.deepEqual(await again.importer.scan(), [])
  assert.deepEqual(again.published, [], 'nothing new, nothing to scan')
})

test('one importer run asks Jellyfin to scan Movies and TV Shows once each, and never TXP1', async () => {
  const context = await setup()
  await mkdir(join(context.library, 'Movies'))
  await addTorrent(context, HASH, 'Robots.2005.1080p', { 'Robots.2005.1080p/Robots.2005.1080p.mp4': film })
  await addTorrent(context, OTHER, 'Sintel.2010.720p', { 'Sintel.2010.720p/Sintel.2010.720p.mkv': film })
  const THIRD = 'c'.repeat(40)
  const name = 'MobLand (Season 2) WEB-DL 1080p'
  await addTorrent(context, THIRD, name, Object.fromEntries([1, 2, 3].map((n) => [`${name}/MobLand.S02E0${n}.1080p.WEB-DL.mkv`, episode(n)])))
  const { importer, published } = await familyRun(context)
  assert.deepEqual((await importer.scan()).map((entry) => entry.result), ['published', 'published', 'published'])

  const calls = []
  const libraries = [
    { Name: 'TV Shows', Locations: [join(context.library, 'TV')], ItemId: 'a'.repeat(32) },
    { Name: 'Movies', Locations: [join(context.library, 'Movies')], ItemId: 'b'.repeat(32) },
    { Name: 'TXP1', Locations: [join(context.root, 'private')], ItemId: 'c'.repeat(32) },
  ]
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`)
    return new URL(url).pathname === '/Library/VirtualFolders' ? Response.json(libraries) : new Response(null, { status: 204 })
  }
  const key = '0123456789abcdef0123456789abcdef'
  const refresh = createJellyfinFolderRefresh({ url: 'http://127.0.0.1:8096' }, { apiKey: key, fetchImpl })
  const logs = []
  const outcome = await refreshJellyfinAfterImport(published, { refresh, roots: [context.library], log: (entry) => logs.push(entry) })
  assert.deepEqual(outcome.refreshed.sort(), ['Movies', 'TV Shows'])
  assert.deepEqual(calls.sort(), ['GET /Library/VirtualFolders', `POST /Items/${'a'.repeat(32)}/Refresh`, `POST /Items/${'b'.repeat(32)}/Refresh`])
  assert.deepEqual(logs, [{ result: 'jellyfin-refresh', libraries: outcome.refreshed, skipped: undefined, failed: undefined, notScanned: undefined }])
  assert.equal(JSON.stringify(logs).includes(key), false)
})

test('no scan without new content or settings, and a Jellyfin failure never undoes or fails the import', async () => {
  const logs = []
  const log = (entry) => logs.push(entry)
  let asked = 0
  const refresh = async () => { asked += 1; throw new Error('Jellyfin could not be reached.') }
  assert.equal(await refreshJellyfinAfterImport([], { refresh, roots: ['/media/family'], log }), null)
  assert.equal(asked, 0)
  assert.deepEqual(logs, [], 'a run with nothing new says nothing about Jellyfin')

  assert.equal(await refreshJellyfinAfterImport(['/media/family/Movies/Robots (2005)/Robots (2005).mp4'], { refresh: null, roots: ['/media/family'], log }), null)
  assert.equal(logs.at(-1).result, 'jellyfin-refresh-off')

  const context = await setup()
  await mkdir(join(context.library, 'Movies'))
  await addTorrent(context, HASH, 'Robots.2005.1080p', { 'Robots.2005.1080p/Robots.2005.1080p.mp4': film, 'Robots.2005.1080p/Robots.2005.en.srt': 'subtitle' })
  const { importer, published } = await familyRun(context)
  const result = await importer.importTorrent(HASH)
  assert.equal(result.result, 'published')
  // Both files of the film are one folder, so one request reaches the refresher.
  const folders = []
  await refreshJellyfinAfterImport(published, { refresh: async (paths) => { folders.push(paths); throw new Error('Jellyfin could not be reached.') }, roots: [context.library], log })
  assert.deepEqual(folders, [[join(context.library, 'Movies', 'Robots (2005)')]])
  assert.deepEqual(logs.at(-1), { result: 'jellyfin-refresh-failed', reason: 'Jellyfin could not be reached.' })
  assert.equal(result.result, 'published')
  assert.equal(JSON.parse(await readFile(join(context.stateDir, `${HASH}.json`), 'utf8')).result, 'published')
  assert.equal((await stat(join(context.library, 'Movies', 'Robots (2005)', 'Robots (2005).mp4'))).nlink, 2)

  // A partial scan (one library refused) is reported as a failure too, naming what was not scanned.
  await refreshJellyfinAfterImport(published, { refresh: async () => ({ refreshed: [], skipped: [], failed: [{ library: 'Movies', reason: 'HTTP 500' }], notScanned: ['x'] }), roots: [context.library], log })
  assert.equal(logs.at(-1).result, 'jellyfin-refresh-failed')
  assert.deepEqual(logs.at(-1).notScanned, ['x'])
})

test('both importer units can reach Jellyfin and check its plain-HTTP address is this machine', async () => {
  for (const name of ['tomifin-family-import.service.example', 'tomifin-family-import-scan.service.example']) {
    const unit = await readFile(new URL(`./family-import/${name}`, import.meta.url), 'utf8')
    // jellyfinConfig() lists this machine's addresses (os.networkInterfaces(), over netlink) to accept http://<LAN address>.
    assert.match(unit, /^RestrictAddressFamilies=.*\bAF_NETLINK\b/m, name)
    assert.match(unit, /^IPAddressDeny=any$/m, name)
    assert.match(unit, /^IPAddressAllow=localhost 192\.168\.1\.81$/m, name)
    assert.match(unit, /^UnsetEnvironment=(?!.*TOMIFY_JELLYFIN).*TOMIFY_RECOVERY_TOKEN/m, name)
  }
})
