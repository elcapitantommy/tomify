import test from 'node:test'
import assert from 'node:assert/strict'
import { appleArtworkUrl, artworkQuality, rankArtworkCandidates } from './recovery-artwork.mjs'

const candidate = (provider, width, height, confidence = 90) => ({ id: `${provider}-${width}-${height}`, provider, url: `https://example.com/${provider}.jpg`, width, height, confidence, selectable: true })

test('provider priority prefers Apple over equal-quality fallbacks', () => {
  const ranked = rankArtworkCandidates([candidate('cover-art-archive', 1200, 1200, 99), candidate('spotify', 1200, 1200), candidate('apple', 1200, 1200)])
  assert.deepEqual(ranked.map((value) => value.provider), ['apple', 'spotify', 'cover-art-archive'])
})

test('clean square high-resolution art beats a low-quality preferred-provider image', () => {
  const ranked = rankArtworkCandidates([candidate('apple', 300, 300), candidate('cover-art-archive', 1200, 1200)])
  assert.equal(ranked[0].provider, 'cover-art-archive')
  assert.equal(ranked[0].quality, 'high')
})

test('minimum resolution and non-square art are labelled as fallback', () => {
  assert.equal(artworkQuality(600, 600).tier, 'preferred')
  assert.equal(artworkQuality(599, 599).tier, 'fallback')
  assert.equal(artworkQuality(1200, 700).tier, 'fallback')
  assert.equal(rankArtworkCandidates([candidate('apple', 100, 100)]).length, 0)
})

test('fallback order remains deterministic when no preferred artwork exists', () => {
  const ranked = rankArtworkCandidates([candidate('youtube', 1280, 720), candidate('cover-art-archive', 500, 500)])
  assert.deepEqual(ranked.map((value) => value.provider), ['cover-art-archive', 'youtube'])
})

test('Apple catalogue artwork URLs can request the target square size', () => {
  assert.equal(appleArtworkUrl('http://is1.mzstatic.com/image/thumb/Music/cover/100x100bb.jpg'), 'https://is1.mzstatic.com/image/thumb/Music/cover/1200x1200bb.jpg')
})
