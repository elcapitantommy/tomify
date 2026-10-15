import test from 'node:test'
import assert from 'node:assert/strict'
import { albumArtworkSearchQueries, baseAlbumTitle, chooseAutomaticAlbumArtwork, isAlbumArtworkUrl, spotifyAlbumCandidate } from './album-artwork-worker.mjs'
import { metadataTextSimilarity } from './recovery-metadata.mjs'

const candidate = (patch = {}) => ({ id: 'spotify:1', provider: 'spotify', url: 'https://i.scdn.co/image/ab67616d0000b273', confidence: 96, square: true, minimumDimension: 640, ...patch })

test('only HTTPS Spotify image hosts are accepted as album artwork', () => {
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co/image/abc'), true)
  assert.equal(isAlbumArtworkUrl('http://i.scdn.co/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co.evil.example/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://coverartarchive.org/release/x/front'), false)
  assert.equal(isAlbumArtworkUrl('not a url'), false)
})

test('base titles drop trailing edition and remaster qualifiers but keep leading brackets', () => {
  assert.equal(baseAlbumTitle('Abbey Road (Remastered 2009)'), 'Abbey Road')
  assert.equal(baseAlbumTitle('OK Computer (Collector\'s Edition) [2009 Remaster]'), 'OK Computer')
  assert.equal(baseAlbumTitle('Hounds of Love - 2018 Remaster'), 'Hounds of Love')
  assert.equal(baseAlbumTitle('Parklife \u2013 Special Edition'), 'Parklife')
  assert.equal(baseAlbumTitle('(What\'s the Story) Morning Glory?'), '(What\'s the Story) Morning Glory?')
  assert.equal(baseAlbumTitle('Blood on the Tracks'), 'Blood on the Tracks')
  assert.deepEqual(albumArtworkSearchQueries('Flood (Deluxe)', 'They Might Be Giants'), ['album:Flood artist:They Might Be Giants', 'Flood They Might Be Giants'])
})

const spotifyAlbum = (name, patch = {}) => ({ id: 'sp1', name, release_date: '1977-02-04', artists: [{ name: 'Fleetwood Mac' }], images: [{ url: 'https://i.scdn.co/image/64', width: 64, height: 64 }, { url: 'https://i.scdn.co/image/640', width: 640, height: 640 }], ...patch })
const score = (album, item) => spotifyAlbumCandidate({ artist: 'Fleetwood Mac', album, releaseDate: '1977' }, item, metadataTextSimilarity, (expected, actual) => String(expected).slice(0, 4) === String(actual).slice(0, 4) ? 1 : 0)

test('Spotify editions match a plain library title confidently, and exact editions rank higher', () => {
  const deluxe = score('Rumours', spotifyAlbum('Rumours (Super Deluxe)'))
  const exact = score('Rumours', spotifyAlbum('Rumours'))
  assert.equal(deluxe.url, 'https://i.scdn.co/image/640')
  assert.ok(deluxe.confidence >= 85, `deluxe confidence ${deluxe.confidence}`)
  assert.ok(exact.confidence > deluxe.confidence)
  assert.ok(score('Rumours (2004 Remaster)', spotifyAlbum('Rumours')).confidence >= 85)
})

test('Spotify results for a different album, a different artist or a non-Spotify image are rejected', () => {
  assert.equal(score('Rumours', spotifyAlbum('Tusk')), null)
  assert.equal(score('Rumours', spotifyAlbum('Rumours', { artists: [{ name: 'Rumours Tribute Band' }] })), null)
  assert.equal(score('Rumours', spotifyAlbum('Rumours', { images: [{ url: 'https://example.com/a.jpg', width: 640, height: 640 }] })), null)
  assert.ok(score('Rumours', spotifyAlbum('Rumours', { artists: [{ name: 'Fleetwood Mac' }, { name: 'Someone Else' }] })).confidence >= 85, 'a credited guest does not sink the artist match')
})

test('automatic replacement takes only a confident, square Spotify image of at least 600px', () => {
  assert.equal(chooseAutomaticAlbumArtwork([candidate()])?.id, 'spotify:1')
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ confidence: 80 })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ square: false })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ minimumDimension: 300 })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ provider: 'apple' })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ url: 'https://example.com/a.jpg' })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ id: 'weak', confidence: 70 }), candidate({ id: 'strong' })])?.id, 'strong')
  assert.equal(chooseAutomaticAlbumArtwork(null), null)
})
