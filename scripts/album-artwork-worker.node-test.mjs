import test from 'node:test'
import assert from 'node:assert/strict'
import { albumArtworkCandidate, albumArtworkSearchQueries, appleAlbumResult, baseAlbumTitle, chooseAutomaticAlbumArtwork, decodeAlbumArtworkUpload, deezerAlbumResult, isAlbumArtworkUrl, spotifyAlbumResult } from '../worker/features/album-artwork.ts'
import { metadataTextSimilarity } from './recovery-metadata.mjs'

const candidate = (patch = {}) => ({ id: 'spotify:1', provider: 'spotify', url: 'https://i.scdn.co/image/ab67616d0000b273', confidence: 96, square: true, minimumDimension: 640, ...patch })

test('only HTTPS Apple, Deezer and Spotify image hosts are accepted as album artwork', () => {
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co/image/abc'), true)
  assert.equal(isAlbumArtworkUrl('http://i.scdn.co/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://i.scdn.co.evil.example/image/abc'), false)
  assert.equal(isAlbumArtworkUrl('https://coverartarchive.org/release/x/front'), false)
  assert.equal(isAlbumArtworkUrl('not a url'), false)
  assert.equal(isAlbumArtworkUrl('https://is1-ssl.mzstatic.com/image/thumb/a/1200x1200bb.jpg'), true)
  assert.equal(isAlbumArtworkUrl('https://e-cdns-images.dzcdn.net/images/cover/a/1000x1000.jpg'), true)
  assert.equal(isAlbumArtworkUrl('https://mzstatic.com.evil.example/a.jpg'), false)
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
const score = (album, item) => albumArtworkCandidate({ artist: 'Fleetwood Mac', album, releaseDate: '1977' }, spotifyAlbumResult(item), metadataTextSimilarity, (expected, actual) => String(expected).slice(0, 4) === String(actual).slice(0, 4) ? 1 : 0)

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
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ provider: 'youtube' })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ url: 'https://example.com/a.jpg' })]), null)
  assert.equal(chooseAutomaticAlbumArtwork([candidate({ id: 'weak', confidence: 70 }), candidate({ id: 'strong' })])?.id, 'strong')
  assert.equal(chooseAutomaticAlbumArtwork(null), null)
})

test('Apple and Deezer results map to their largest artwork and score like Spotify', () => {
  const apple = appleAlbumResult({ collectionId: 1, collectionName: 'Rumours', artistName: 'Fleetwood Mac', releaseDate: '1977-02-04T08:00:00Z', artworkUrl100: 'http://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg', collectionViewUrl: 'https://music.apple.com/gb/album/rumours/1' })
  assert.deepEqual(apple.image, { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/1200x1200bb.jpg', width: 1200, height: 1200 })
  const deezer = deezerAlbumResult({ id: 2, title: 'Rumours (Super Deluxe)', link: 'https://www.deezer.com/album/2', cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/x/1000x1000.jpg', artist: { name: 'Fleetwood Mac' } })
  const wanted = { artist: 'Fleetwood Mac', album: 'Rumours', releaseDate: '1977' }
  const year = (expected, actual) => !actual ? 0.5 : String(expected).slice(0, 4) === String(actual).slice(0, 4) ? 1 : 0
  assert.equal(albumArtworkCandidate(wanted, apple, metadataTextSimilarity, year).confidence, 100)
  assert.ok(albumArtworkCandidate(wanted, deezer, metadataTextSimilarity, year).confidence >= 85)
  assert.equal(albumArtworkCandidate(wanted, deezerAlbumResult({ ...deezer, id: 3, title: 'Tusk' }), metadataTextSimilarity, year), null)
  assert.equal(albumArtworkCandidate(wanted, appleAlbumResult({ collectionId: 4, collectionName: 'Rumours', artistName: 'Fleetwood Mac' }), metadataTextSimilarity, year), null, 'no artwork, no candidate')
})

test('uploaded album artwork must be a real JPEG, PNG or WebP under 1 MB', () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')
  assert.deepEqual(decodeAlbumArtworkUpload(jpeg), { contentType: 'image/jpeg', base64: jpeg.split(',')[1], size: 7 })
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64')
  assert.equal(decodeAlbumArtworkUpload(png).contentType, 'image/png')
  assert.match(decodeAlbumArtworkUpload('data:image/jpeg;base64,' + Buffer.from('<svg>').toString('base64')).error, /not a JPEG/)
  assert.match(decodeAlbumArtworkUpload('data:image/png;base64,' + jpeg.split(',')[1]).error, /not a JPEG/)
  assert.match(decodeAlbumArtworkUpload('data:image/svg+xml;base64,PHN2Zz4=').error, /JPEG, PNG or WebP/)
  assert.match(decodeAlbumArtworkUpload('data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_000_000)]).toString('base64')).error, /too large/)
})
