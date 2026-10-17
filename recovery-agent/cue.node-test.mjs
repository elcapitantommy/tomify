import assert from 'node:assert/strict'
import { spawnSync, execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { cueTimeSeconds, cueTrackPlans, expandCueImages, matchCueImage, parseCueSheet, splitDiscMarker } from './cue.mjs'

const SHEET = `﻿REM GENRE Rock
REM DATE 1987
PERFORMER "Aerosmith"
TITLE "Permanent Vacation (CD1)"
FILE "Aerosmith - Permanent Vacation.wav" WAVE
  TRACK 01 AUDIO
    TITLE "Heart's Done Time"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Magic Touch"
    INDEX 00 00:01:00
    INDEX 01 00:01:37
  TRACK 03 AUDIO
    TITLE "Rag Doll"
    PERFORMER "Aerosmith feat. Someone"
    INDEX 01 00:02:00
`

test('cue times are minutes, seconds and 1/75 s frames', () => {
  assert.equal(cueTimeSeconds('01:02:00'), 62)
  assert.equal(cueTimeSeconds('00:00:75'), null)
  assert.equal(cueTimeSeconds('nonsense'), null)
  assert.ok(Math.abs(cueTimeSeconds('00:01:37') - (1 + 37 / 75)) < 1e-9)
})

test('parses a single-file cue sheet, using INDEX 01 as each track start', () => {
  const sheet = parseCueSheet(SHEET)
  assert.equal(sheet.performer, 'Aerosmith')
  assert.equal(sheet.file, 'Aerosmith - Permanent Vacation.wav')
  assert.equal(sheet.date, '1987')
  assert.deepEqual(sheet.tracks.map((track) => track.title), ["Heart's Done Time", 'Magic Touch', 'Rag Doll'])
  assert.equal(sheet.tracks[2].performer, 'Aerosmith feat. Someone')
  assert.ok(Math.abs(sheet.tracks[1].start - (1 + 37 / 75)) < 1e-9)
})

test('rejects cue sheets that are not one image with ordered tracks', () => {
  assert.equal(parseCueSheet(SHEET.replace('INDEX 01 00:02:00', 'INDEX 01 00:00:30')), null)
  assert.equal(parseCueSheet(`${SHEET}FILE "second.wav" WAVE\n  TRACK 04 AUDIO\n    INDEX 01 00:00:00\n`), null)
  assert.equal(parseCueSheet('FILE "a.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'), null)
})

test('disc markers are taken off the album title', () => {
  assert.deepEqual(splitDiscMarker('Permanent Vacation (CD1)'), { title: 'Permanent Vacation', disc: 1 })
  assert.deepEqual(splitDiscMarker('O, Yeah! [Disc 2]'), { title: 'O, Yeah!', disc: 2 })
  assert.deepEqual(splitDiscMarker('Pump'), { title: 'Pump', disc: null })
})

test('finds the image even when the cue sheet names the pre-conversion .wav', () => {
  const sheet = parseCueSheet(SHEET)
  const files = [{ path: '/t/PV/Aerosmith - Permanent Vacation.flac', name: 'Aerosmith - Permanent Vacation.flac' }, { path: '/t/Other/x.flac', name: 'x.flac' }]
  assert.equal(matchCueImage('/t/PV/whatever.cue', sheet, files), files[0])
  assert.equal(matchCueImage('/t/Elsewhere/whatever.cue', sheet, files), null)
})

test('track plans tag album, artist, track and disc numbers', () => {
  const sheet = parseCueSheet(SHEET)
  const plans = cueTrackPlans(sheet, { path: '/t/PV/image.flac', name: 'image.flac' }, '/t/PV/image.cue', '/out')
  assert.equal(plans.length, 3)
  assert.equal(plans[0].output, "/out/01 - Heart's Done Time.flac")
  assert.ok(plans[0].args.includes('ALBUM=Permanent Vacation'))
  assert.ok(plans[0].args.includes('DISCNUMBER=1'))
  assert.ok(plans[0].args.includes('TRACKTOTAL=3'))
  assert.ok(plans[2].args.includes('ARTIST=Aerosmith feat. Someone'))
  assert.ok(plans[2].args.includes('ALBUMARTIST=Aerosmith'))
  assert.ok(plans[1].args.includes('-t'))
  assert.ok(!plans[2].args.includes('-t'), 'the last track runs to the end of the image')
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
test('splits a real FLAC image into tagged tracks of the right length', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-cue-'))
  try {
    const folder = join(root, 'Permanent Vacation')
    await mkdir(folder)
    const image = join(folder, 'Aerosmith - Permanent Vacation.flac')
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'flac', image])
    await writeFile(join(folder, 'Aerosmith - Permanent Vacation.cue'), SHEET)
    const other = { path: join(root, 'loose.flac'), size: 1, name: 'loose.flac' }
    const run = async (command, args) => { await promisify(execFile)(command, args) }
    const files = await expandCueImages([{ path: image, size: (await stat(image)).size, name: 'Aerosmith - Permanent Vacation.flac' }, other], { destination: join(root, 'split'), run })
    assert.equal(files.length, 4)
    assert.deepEqual(files.slice(0, 3).map((file) => file.name), ["01 - Heart's Done Time.flac", '02 - Magic Touch.flac', '03 - Rag Doll.flac'])
    assert.equal(files[3], other)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=album,track,disc', '-of', 'json', files[1].path], { encoding: 'utf8' })
    const format = JSON.parse(probe.stdout).format
    assert.ok(Math.abs(Number(format.duration) - (2 - (1 + 37 / 75))) < 0.05)
    const tags = Object.fromEntries(Object.entries(format.tags).map(([key, value]) => [key.toLowerCase(), value]))
    assert.equal(tags.album, 'Permanent Vacation')
    assert.equal(tags.track, '2')
    assert.equal(tags.disc, '1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps an image whose split fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-cue-'))
  try {
    const image = join(root, 'Aerosmith - Permanent Vacation.flac')
    await writeFile(image, 'x')
    await writeFile(join(root, 'a.cue'), SHEET)
    const file = { path: image, size: 1, name: 'Aerosmith - Permanent Vacation.flac' }
    const messages = []
    const files = await expandCueImages([file], { destination: join(root, 'split'), run: async () => { throw new Error('boom') }, log: (message) => messages.push(message) })
    assert.deepEqual(files, [file])
    assert.match(messages[0], /Could not split/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
