import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeToolOutput, foldName, hasReplacementCharacter, preferRequestedName } from './text-encoding.mjs'
import { ffprobeTagJsonFormat } from './metadata.mjs'

test('decodeToolOutput keeps valid UTF-8 and reads stray legacy bytes as Windows-1252', () => {
  assert.equal(decodeToolOutput(Buffer.from('Mötley Crüe — Dr. Feelgood 🎸', 'utf8')), 'Mötley Crüe — Dr. Feelgood 🎸')
  assert.equal(decodeToolOutput(Buffer.from([0x4d, 0xf6, 0x74, 0x6c, 0x65, 0x79, 0x20, 0x43, 0x72, 0xfc, 0x65])), 'Mötley Crüe')
  assert.equal(decodeToolOutput(Buffer.from([0x93, 0x51, 0x94, 0x20, 0x80])), '“Q” €')
  // A mixed buffer: valid UTF-8 JSON around one Latin-1 tag value.
  const mixed = Buffer.concat([Buffer.from('{"album":"Señor","artist":"', 'utf8'), Buffer.from([0x4d, 0xf6, 0x74, 0x6c, 0x65, 0x79]), Buffer.from('"}', 'utf8')])
  assert.deepEqual(JSON.parse(decodeToolOutput(mixed)), { album: 'Señor', artist: 'Mötley' })
  // Truncated, overlong and surrogate sequences are not valid UTF-8, so each byte is read on its own.
  assert.equal(decodeToolOutput(Buffer.from([0x41, 0xc3])), 'AÃ')
  assert.equal(decodeToolOutput(Buffer.from([0xc0, 0xaf])), 'À¯')
  assert.equal(decodeToolOutput(Buffer.from([0xed, 0xa0, 0x80])), 'í €')
})

test('foldName ignores accents, case and spacing', () => {
  assert.equal(foldName('Mötley  Crüe'), 'motley crue')
  assert.equal(foldName(' Motley Crue '), 'motley crue')
  assert.equal(foldName('Beyoncé'), foldName('beyonce'))
  assert.notEqual(foldName('Motley Crue'), foldName('Motley Crew'))
  assert.equal(hasReplacementCharacter('M�tley'), true)
  assert.equal(hasReplacementCharacter('Mötley'), false)
})

test('preferRequestedName keeps the requested spelling for accent-only differences and mangled tags', () => {
  assert.equal(preferRequestedName('Mötley Crüe', 'Motley Crue'), 'Motley Crue')
  assert.equal(preferRequestedName('Motley Crue', 'Mötley Crüe'), 'Mötley Crüe')
  assert.equal(preferRequestedName('M�tley Cr�e', 'Mötley Crüe'), 'Mötley Crüe')
  assert.equal(preferRequestedName('M�tley Cr�e', 'Motley Crue'), 'Motley Crue')
  assert.equal(preferRequestedName('M�tley Cr�e', 'Bon Jovi'), 'M�tley Cr�e')
  assert.equal(preferRequestedName('They Might Be Giants', 'they might be giants'), 'They Might Be Giants')
  assert.equal(preferRequestedName('Various Guest', 'Mötley Crüe'), 'Various Guest')
  assert.equal(preferRequestedName('', 'Mötley Crüe'), 'Mötley Crüe')
  assert.equal(preferRequestedName('Mötley Crüe', ''), 'Mötley Crüe')
  assert.equal(preferRequestedName('', ''), null)
})

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0
test('ffprobe with the agent format passes Latin-1 FLAC tags through for decoding', { skip: !ffmpegAvailable && 'ffmpeg/ffprobe not installed' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tomify-encoding-'))
  const path = join(directory, 'latin1.flac')
  // A Vorbis comment holding Latin-1 bytes, as some FLAC rips ship. Process arguments are always
  // UTF-8, so the raw bytes go in through an ffmetadata file instead.
  const metadataPath = join(directory, 'metadata.txt')
  await writeFile(metadataPath, Buffer.concat([Buffer.from(';FFMETADATA1\nartist=', 'ascii'), Buffer.from([0x4d, 0xf6, 0x74, 0x6c, 0x65, 0x79, 0x20, 0x43, 0x72, 0xfc, 0x65, 0x0a])]))
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-i', metadataPath, '-map', '0:a', '-map_metadata', '1', '-t', '0.2', path])
  assert.equal(made.status, 0, String(made.stderr))
  const defaultProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist', '-of', 'json', path])
  const agentProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist', '-of', ffprobeTagJsonFormat, path])
  assert.equal(JSON.parse(decodeToolOutput(defaultProbe.stdout)).format.tags.artist, 'M�tley Cr�e')
  assert.equal(JSON.parse(decodeToolOutput(agentProbe.stdout)).format.tags.artist, 'Mötley Crüe')
})
