import test from 'node:test'
import assert from 'node:assert/strict'
import { albumArtworkSearchTitles, chooseAutomaticAlbumArtwork, isAlbumArtworkUrl } from './album-artwork-worker.mjs'

const candidate = (patch = {}) => ({ id: 'spotify:1', provider: 'spotify', url: 'https://i.scdn.co/image/ab67616d0000b273', confidence: 96, square: true, minimumDimension: 640, ...patch })

test('only HTTPS Spotify image hosts are accepted as album artwork', () => {
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co/image/abc'), true)
  assert.equal(isAlbumArtworkUrl('http://i.scdn.co/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co.evil.example/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://coverartarchive.org/release/x/front'), false)
  assert.equal(isAlbumArtworkUrl('not a url'), false)
})

test('search titles retry without trailing edition and remaster qualifiers', () => {
  assert.deepEqual(albumArtworkSearchTitles('Flood'), ['Flood'])
  assert.deepEqual(albumArtworkSearchTitles('OK Computer (Collector\'s Edition) [2009 Remaster]'), ['OK Computer (Collector\'s Edition) [2009 Remaster]', 'OK Computer'])
  assert.deepEqual(albumArtworkSearchTitles('(What\'s the Story) Morning Glory?'), ['(What\'s the Story) Morning Glory?'])
  assert.deepEqual(albumArtworkSearchTitles(''), [])
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
