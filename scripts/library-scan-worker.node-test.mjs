import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLibrarySong, parseRecoveryPlayback, pendingRecoveryPlayback, playbackCheckDue, playbackTimedOut, recoveryPlaybackTarget } from '../worker/features/library-scan.ts'

const mbid = '00000000-0000-4000-8000-000000000001'
const target = { path: '/recovery/They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', recordingId: null }

test('a library song matches by title and artist, filtered by the path Navidrome reports', () => {
  const songs = [
    { id: 'master', title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', path: 'Masters/TMBG/Flood/02.mp3' },
    { id: 'imported', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', path: 'They Might Be Giants/Flood/01 - Birdhouse in Your Soul.flac' },
  ]
  assert.equal(matchLibrarySong(songs, target)?.id, 'imported')
  assert.equal(matchLibrarySong(songs.slice(0, 1), target), null, 'a same-named track at another path is not the import')
  assert.equal(matchLibrarySong([{ id: 'no-path', title: 'birdhouse in your soul', artist: 'THEY MIGHT BE GIANTS' }], target)?.id, 'no-path')
  assert.equal(matchLibrarySong([{ id: 'other', title: 'Particle Man', artist: 'They Might Be Giants' }], target), null)
})

test('a library song matches by MusicBrainz recording ID whatever its tags say', () => {
  assert.equal(matchLibrarySong([{ id: 'tagged', title: 'Birdhouse (2010 Remaster)', artist: 'TMBG', musicBrainzId: mbid }], { ...target, recordingId: mbid })?.id, 'tagged')
})

test('the playback target comes from the selected imported candidate, preferring the wanted track of a release', () => {
  assert.equal(recoveryPlaybackTarget({ title: 'x', candidates: [{ id: 'c', selected: true, importedPath: null }] }), null)
  const item = { title: 'Particle Man', artist: 'TMBG', musicBrainzId: mbid, candidates: [{ id: 'c1', selected: true, importedPath: '/r/Flood/01.flac', provenance: { job: { id: 'j1' }, importedTracks: [{ path: '/r/Flood/01.flac', title: 'Theme from Flood', artist: 'They Might Be Giants' }, { path: '/r/Flood/05.flac', title: 'Particle Man', artist: 'They Might Be Giants' }] } }] }
  assert.deepEqual(recoveryPlaybackTarget(item), { path: '/r/Flood/05.flac', title: 'Particle Man', artist: 'They Might Be Giants', recordingId: mbid, key: 'c1:j1:/r/Flood/01.flac' })
})

test('pending checks are due every 15 seconds and time out after ten minutes', () => {
  const start = Date.parse('2026-10-16T12:00:00Z')
  const pending = pendingRecoveryPlayback({ ...target, key: 'k' }, start)
  assert.equal(playbackCheckDue(pending, start), true)
  const checked = { ...pending, checkedAt: new Date(start).toISOString() }
  assert.equal(playbackCheckDue(checked, start + 14_999), false)
  assert.equal(playbackCheckDue(checked, start + 15_000), true)
  assert.equal(playbackCheckDue({ ...checked, state: 'ready' }, start + 60_000), false)
  assert.equal(playbackTimedOut(pending, start + 599_999), false)
  assert.equal(playbackTimedOut(pending, start + 600_000), true)
  assert.equal(parseRecoveryPlayback(JSON.stringify(pending)).state, 'scan-pending')
  assert.equal(parseRecoveryPlayback('{"state":"other"}'), null)
  assert.equal(parseRecoveryPlayback('not json'), null)
})
