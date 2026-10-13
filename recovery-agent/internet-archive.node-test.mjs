import test from 'node:test'
import assert from 'node:assert/strict'
import { archiveCandidate, archiveDownloadUrl, archiveSearchUrl, selectArchiveAudioFiles, validateArchiveDownloadUrl } from './internet-archive.mjs'

test('builds a field-restricted Internet Archive audio search', () => {
  const url = new URL(archiveSearchUrl({ artist: 'Zara Larsson', title: 'Lush Life' }))
  assert.equal(url.origin, 'https://archive.org')
  assert.match(url.searchParams.get('q'), /mediatype:audio/)
  assert.match(url.searchParams.get('q'), /Zara Larsson Lush Life/)
})

test('prefers original lossless files and produces auditable provenance', () => {
  const metadata = { metadata: { title: 'Release', creator: 'Artist', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }, files: [
    { name: 'derived.mp3', source: 'derivative', format: 'VBR MP3', size: '3000' },
    { name: 'master.flac', source: 'original', format: 'Flac', size: '9000', length: '201.5', sha1: 'abc' },
  ] }
  const [file] = selectArchiveAudioFiles(metadata)
  assert.equal(file.name, 'master.flac')
  const candidate = archiveCandidate('safe_item', metadata.metadata, file)
  assert.equal(candidate.duration, 201.5)
  assert.equal(candidate.provenance.filename, 'master.flac')
  assert.equal(candidate.provenance.licenseUrl, metadata.metadata.licenseurl)
})

test('constructs and validates only trusted Archive download locations', () => {
  assert.equal(archiveDownloadUrl('item', 'disc/track 01.flac'), 'https://archive.org/download/item/disc/track%2001.flac')
  assert.match(validateArchiveDownloadUrl('https://ia801.example.us.archive.org/file'), /archive\.org/)
  assert.throws(() => validateArchiveDownloadUrl('https://example.com/file'), /untrusted host/)
  assert.throws(() => archiveDownloadUrl('../item', 'track.mp3'), /invalid/)
  assert.throws(() => archiveDownloadUrl('item', '../track.mp3'), /invalid/)
})
