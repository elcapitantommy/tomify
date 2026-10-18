import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createStyleTagger, existingStyle, genreName, moodsFromTags, probedTags, styleWriteArguments, topGenres } from './track-style.mjs'
import { backfillStyle, parseArguments } from './style-backfill.mjs'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0
const staging = '/state/import-staging/job'

// MusicBrainz and Last.fm stand-ins: each URL that starts with a key gets that key's JSON (or text).
function fakeFetch(routes) {
  const calls = []
  const fetcher = async (url) => {
    calls.push(String(url))
    const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix))
    if (!key) return new Response('', { status: 404 })
    const body = routes[key]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }
  return { fetcher, calls }
}

const mb = 'https://musicbrainz.org/ws/2/'
const quiet = { sleep: async () => {}, log: () => {}, today: () => '2026-10-18' }

test('genre names read like the rest of the library', () => {
  assert.deepEqual(['deep house', 'drum and bass', 'uk garage', 'r&b', 'lo-fi hip hop', 'hip-hop'].map(genreName), ['Deep House', 'Drum and Bass', 'UK Garage', 'R&B', 'Lo-Fi Hip Hop', 'Hip-Hop'])
})

test('existing tags are read from any container and empty genres count as missing', () => {
  const tags = probedTags({ format: { tags: { TBPM: '128', genre: 'Other', TMOO: 'Dark', 'MusicBrainz Track Id': 'rec-1' } }, streams: [{ tags: { ARTIST: 'Burial' } }] })
  assert.deepEqual(existingStyle(tags), { bpm: 128, genre: '', mood: 'Dark', checked: false, recordingId: 'rec-1', releaseGroupId: null, artist: 'Burial', title: '' })
})

test('the most voted genres and moods win, and tags that are not moods are ignored', () => {
  assert.deepEqual(topGenres([{ name: 'house', count: 2 }, { name: 'deep house', count: 5 }, { name: 'techno', count: 1 }, { name: 'garage', count: 1 }]), ['Deep House', 'House', 'Techno'])
  assert.deepEqual(moodsFromTags([{ name: 'seen live', count: 90 }, { name: 'Chillout', count: 40 }, { name: 'mellow', count: 30 }, { name: 'happy', count: 50 }, { name: 'dark', count: 10 }]), ['Chill', 'Upbeat'])
})

test('tags are copied with ffmpeg in the names each container uses, never re-encoded', () => {
  const style = { bpm: 123.6, genres: ['House', 'Deep House'], moods: ['Chill'], checked: '2026-10-18' }
  assert.deepEqual(styleWriteArguments('/a/1.flac', '/a/.1.tmp.flac', style).slice(5), ['-map', '0', '-c', 'copy', '-map_metadata', '0',
    '-metadata', 'BPM=124', '-metadata', 'GENRE=House; Deep House', '-metadata', 'MOOD=Chill', '-metadata', 'TOMIFY_STYLE_CHECKED=2026-10-18', '/a/.1.tmp.flac'])
  assert.deepEqual(styleWriteArguments('/a/1.opus', '/a/t.opus', style).slice(11), ['-map_metadata:s:a:0', '0:s:a:0', '-metadata:s:a:0', 'BPM=124', '-metadata:s:a:0', 'GENRE=House; Deep House', '-metadata:s:a:0', 'MOOD=Chill', '-metadata:s:a:0', 'TOMIFY_STYLE_CHECKED=2026-10-18', '/a/t.opus'])
  assert.deepEqual(styleWriteArguments('/a/1.mp3', '/a/t.mp3', style).filter((arg) => arg.includes('=')), ['TBPM=124', 'genre=House; Deep House', 'TMOO=Chill', 'TOMIFY_STYLE_CHECKED=2026-10-18'])
  assert.deepEqual(styleWriteArguments('/a/1.m4a', '/a/t.m4a', style).filter((arg) => arg.includes('=')), ['tmpo=124', 'genre=House; Deep House'])
})

test('genres come from the recording first, then its release group, then the artist', async () => {
  const { fetcher, calls } = fakeFetch({
    [`${mb}recording/rec-1?`]: { genres: [], tags: [{ name: 'melancholic', count: 2 }], 'artist-credit': [{ artist: { id: 'artist-1' } }] },
    [`${mb}release-group/rg-1?`]: { genres: [], tags: [] },
    [`${mb}artist/artist-1?`]: { genres: [{ name: 'dubstep', count: 4 }, { name: 'uk garage', count: 6 }] },
  })
  const tagger = createStyleTagger({ lookup: true, fetcher, ...quiet })
  assert.deepEqual(await tagger.lookupStyle({ recordingId: 'rec-1', releaseGroupId: 'rg-1', artist: 'Burial', title: 'Archangel' }), { genres: ['UK Garage', 'Dubstep'], moods: ['Sad'] })
  assert.deepEqual(calls.map((url) => url.slice(mb.length).split('?')[0]), ['recording/rec-1', 'release-group/rg-1', 'artist/artist-1'])
  // The artist's answer is reused for the rest of the album.
  await tagger.lookupStyle({ recordingId: 'rec-1', releaseGroupId: 'rg-1', artist: 'Burial', title: 'Near Dark' })
  assert.equal(calls.length, 4)
})

test('a file without a recording id is matched by an exact artist and title search', async () => {
  const { fetcher, calls } = fakeFetch({
    [`${mb}recording?query=`]: { recordings: [
      { id: 'cover', score: 100, title: 'Teardrop', 'artist-credit': [{ name: 'José González' }] },
      { id: 'rec-2', score: 100, title: 'Teardrop', 'artist-credit': [{ name: 'Massive Attack' }] },
    ] },
    [`${mb}recording/rec-2?`]: { genres: [{ name: 'trip hop', count: 3 }], tags: [] },
  })
  const tagger = createStyleTagger({ lookup: true, fetcher, ...quiet })
  assert.deepEqual(await tagger.lookupStyle({ recordingId: null, releaseGroupId: null, artist: 'Massive attack', title: 'Teardrop' }), { genres: ['Trip Hop'], moods: [] })
  assert.match(decodeURIComponent(calls[0]), /recording:"Teardrop" AND artist:"Massive attack"/)
})

test('Last.fm adds moods, and its tags count as genres only when MusicBrainz lists them as genres', async () => {
  const { fetcher } = fakeFetch({
    'https://ws.audioscrobbler.com/2.0/': { toptags: { tag: [{ name: 'chillout', count: 100 }, { name: 'electronic', count: 80 }, { name: 'seen live', count: 60 }, { name: 'ambient', count: 5 }] } },
    [`${mb}genre/all?fmt=txt`]: 'ambient\nelectronic\nhouse\n',
  })
  const tagger = createStyleTagger({ lookup: true, lastfmKey: 'key', fetcher, ...quiet })
  assert.deepEqual(await tagger.lookupStyle({ recordingId: null, releaseGroupId: null, artist: 'Bonobo', title: 'Kiara' }), { genres: ['Electronic'], moods: ['Chill'] })
})

test('style tagging is off without BPM_PATH or STYLE_LOOKUP and never touches files outside staging', async () => {
  const spawn = () => { throw new Error('nothing should run') }
  assert.deepEqual(await createStyleTagger({ bpm: '', lookup: false, spawn })([{ role: 'derivative', source: `${staging}/0.flac`, destination: '/r/a.flac' }], staging), { tagged: 0, failed: 0 })
  assert.deepEqual(await createStyleTagger({ bpm: 'bpm', spawn })([
    { role: 'derivative', source: '/downloads/0.flac', destination: '/r/a.flac' },
    { role: 'original', source: `${staging}/1.flac`, destination: '/r/.tomify-source/a.flac' },
    { role: 'derivative', source: `${staging}/2.wav`, destination: '/r/a.wav' },
  ], staging), { tagged: 0, failed: 0 })
})

test('backfill arguments name the folders and the options', () => {
  assert.deepEqual(parseArguments(['--dry-run', '--limit', '5', '/srv/music']), { dryRun: true, recheck: false, limit: 5, roots: [resolve('/srv/music')] })
  assert.throws(() => parseArguments(['--dry-run']), /library folder/)
})

test('real ffmpeg: an import measures BPM, looks up genre and mood and keeps every other tag', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'tomify-style-test-'))
  try {
    const stagingRoot = join(base, 'staging')
    await mkdir(stagingRoot)
    // bpm-tools stand-in, run with node so it works on Windows too: reads the decoded audio and prints a tempo.
    const bpmScript = join(base, 'bpm.mjs')
    await writeFile(bpmScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('127.6'))\n")
    const spawn = (command, args, options) => command === 'fake-bpm' ? nodeSpawn(process.execPath, [bpmScript], options) : nodeSpawn(command, args, options)
    for (const name of ['0.flac', '1.mp3']) {
      const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'artist=Bicep', '-metadata', 'title=Glue', '-metadata', 'MUSICBRAINZ_TRACKID=rec-3', '-metadata', 'REPLAYGAIN_TRACK_GAIN=-4.00 dB', join(stagingRoot, name)])
      assert.equal(made.status, 0, made.stderr?.toString())
    }
    const { fetcher } = fakeFetch({ [`${mb}recording/rec-3?`]: { genres: [{ name: 'breakbeat', count: 2 }], tags: [{ name: 'dreamy', count: 1 }] } })
    const tag = createStyleTagger({ bpm: 'fake-bpm', lookup: true, fetcher, spawn, ...quiet })
    const entries = ['0.flac', '1.mp3'].map((name) => ({ role: 'derivative', source: join(stagingRoot, name), destination: join(base, 'library', name) }))
    assert.deepEqual(await tag(entries, stagingRoot), { tagged: 2, failed: 0 })
    for (const name of ['0.flac', '1.mp3']) {
      const report = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', join(stagingRoot, name)]).stdout)
      const tags = probedTags(report)
      assert.deepEqual({ ...existingStyle(tags), recordingId: undefined }, { bpm: 128, genre: 'Breakbeat', mood: 'Dreamy', checked: true, recordingId: undefined, releaseGroupId: null, artist: 'Bicep', title: 'Glue' })
      assert.equal(tags.replaygaintrackgain, '-4.00 dB')
    }
    assert.deepEqual((await readdir(stagingRoot)).sort(), ['0.flac', '1.mp3'])
    // Backfilling the same files again finds nothing missing and changes nothing.
    const lines = []
    assert.deepEqual(await backfillStyle({ roots: [stagingRoot], dryRun: false, recheck: false, limit: Infinity }, { tagger: tag, print: (line) => lines.push(line) }), { checked: 2, tagged: 0, failed: 0 })
    assert.deepEqual(lines, [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
