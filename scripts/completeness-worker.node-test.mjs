import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseReleaseEdition, completenessText, editionFitsLocal, mapReleaseTracklist, matchRecoveryItems, releaseGroupTypeFit, releaseTrackCount, summariseReleaseEditions } from '../worker/features/completeness.ts'

const mbid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const release = (id, trackCount, patch = {}) => ({ id: mbid(id), title: 'Flood', status: 'Official', date: '1990-01-15', country: 'US', media: [{ format: 'CD', 'track-count': trackCount }], ...patch })

test('edition choice compares a partial album with the standard edition, not the closest track count', () => {
  const editions = summariseReleaseEditions([release(1, 19), release(2, 19, { country: 'GB' }), release(3, 31, { date: '2013-01-01', disambiguation: 'deluxe' }), release(4, 4, { status: 'Promotion' })])
  assert.equal(chooseReleaseEdition(editions, 1).trackCount, 19)
  assert.equal(chooseReleaseEdition(editions, 19).trackCount, 19)
})

test('edition choice follows a library that holds a larger deluxe edition', () => {
  const editions = summariseReleaseEditions([release(1, 19), release(2, 19), release(3, 31, { date: '2013-01-01' })])
  assert.equal(chooseReleaseEdition(editions, 30).id, mbid(3))
})

test('edition summaries exclude bootlegs and pseudo-releases and total multi-disc track counts', () => {
  const editions = summariseReleaseEditions([release(1, 19), release(2, 19, { status: 'Bootleg' }), release(3, 0, { status: 'Pseudo-Release' }), release(4, 0, { media: [{ format: 'CD', 'track-count': 12 }, { format: 'DVD', 'track-count': 3 }] })])
  assert.deepEqual(editions.map((edition) => edition.id), [mbid(1), mbid(4)])
  assert.equal(editions[1].trackCount, 15)
  assert.equal(editions[1].format, 'CD + DVD')
  assert.equal(chooseReleaseEdition([], 3), null)
})

test('maps a MusicBrainz release into disc-aware tracks with recording IDs, seconds, artists and ISRCs', () => {
  const tracklist = mapReleaseTracklist({
    id: mbid(1), title: 'Flood', date: '1990-01-15', country: 'US', status: 'Official', 'release-group': { id: mbid(9) },
    'artist-credit': [{ name: 'They Might Be Giants' }],
    media: [
      { position: 1, format: 'CD', tracks: [{ position: 2, number: '2', title: 'Birdhouse in Your Soul', length: 193_000, recording: { id: mbid(20), isrcs: ['USEE19000002'] } }] },
      { position: 2, format: 'CD', tracks: [{ position: 1, number: '1', title: 'Guest', length: null, 'artist-credit': [{ name: 'A', joinphrase: ' & ' }, { name: 'B' }], recording: { id: 'not-an-mbid', length: 61_250 } }] },
    ],
  }, 'album-1', 'auto')
  assert.equal(tracklist.releaseGroupId, mbid(9))
  assert.equal(tracklist.discCount, 2)
  assert.deepEqual(tracklist.tracks[0], { key: '1-2', disc: 1, number: 2, title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', length: 193, recordingId: mbid(20), isrc: 'USEE19000002' })
  assert.deepEqual(tracklist.tracks[1], { key: '2-1', disc: 2, number: 1, title: 'Guest', artist: 'A & B', length: 61.3, recordingId: null, isrc: null })
})

test('existing Recovery items are found by recording ID, then by normalised artist and title', () => {
  const tracks = [{ key: '1-1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', recordingId: mbid(1) }, { key: '1-2', title: 'Particle Man', artist: 'They Might Be Giants', recordingId: mbid(2) }, { key: '1-3', title: 'Dead', artist: 'They Might Be Giants', recordingId: null }]
  const rows = [{ id: 'r1', artist: 'Someone else', title: 'Renamed', musicBrainzId: mbid(1), status: 'needs-upgrade' }, { id: 'r2', artist: 'they might be giants', title: 'PARTICLE MAN', musicBrainzId: null, status: 'missing' }]
  assert.deepEqual(matchRecoveryItems(tracks, rows), { '1-1': { id: 'r1', status: 'needs-upgrade' }, '1-2': { id: 'r2', status: 'missing' } })
})

test('text normalisation keeps non-Latin characters so unrelated titles never collapse to empty strings', () => {
  assert.equal(completenessText('Sigur Rós — Ágætis byrjun'), 'sigur ros agætis byrjun')
  assert.notEqual(completenessText('残酷な天使のテーゼ'), '')
})

test('an edition far smaller than a full local album does not fit it, but partial local albums are left alone', () => {
  assert.equal(editionFitsLocal(1, 12), false)
  assert.equal(editionFitsLocal(12, 12), true)
  assert.equal(editionFitsLocal(6, 12), true)
  assert.equal(editionFitsLocal(19, 1), true)
  assert.equal(editionFitsLocal(1, 3), true)
  assert.equal(releaseTrackCount({ media: [{ 'track-count': 10 }, { tracks: [{}, {}] }] }), 12)
})

test('release group type fit prefers albums for many local tracks and singles for one or two', () => {
  const album = { 'primary-type': 'Album' }
  const single = { 'primary-type': 'Single' }
  assert.ok(releaseGroupTypeFit(album, 12) > releaseGroupTypeFit(single, 12))
  assert.ok(releaseGroupTypeFit(single, 1) > releaseGroupTypeFit(album, 1))
  assert.equal(releaseGroupTypeFit(single, 0), 0)
  assert.equal(releaseGroupTypeFit({}, 12), 0)
})
