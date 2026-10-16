import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogueSearchQueries, findCatalogueMatch, matchCatalogueItem, primaryArtist, stripEditionSuffix } from '../src/lib/catalogue-match.mjs'

const wanted = (overrides = {}) => ({ position: 0, status: 'unmatched', title: 'Lush Life', artists: ['Zara Larsson'], album: '1', duration: 201, ...overrides })
const local = (id, overrides = {}) => ({ id, title: 'Lush Life', artist: 'Zara Larsson', album: '1', duration: 201, ...overrides })

test('strong canonical metadata matches an existing local track', () => { const result = matchCatalogueItem(wanted(), [local('a')]); assert.equal(result.status, 'available'); assert.equal(result.localTrackId, 'a'); assert.equal(result.matchConfidence, 98) })
test('ISRC is a strong match signal', () => { assert.equal(matchCatalogueItem(wanted({ isrc: 'SE3I51500013' }), [local('a', { title: 'Different display title', isrc: 'SE3I51500013' })]).matchConfidence, 99) })
test('ambiguous matches require review', () => { assert.equal(matchCatalogueItem(wanted(), [local('a'), local('b')]).status, 'review') })
test('live and remix variants are not silently substituted', () => { assert.equal(matchCatalogueItem(wanted(), [local('a', { title: 'Lush Life (Live)' })]).status, 'missing'); assert.equal(matchCatalogueItem(wanted({ title: 'Lush Life (Remix)' }), [local('b')]).status, 'missing') })
test('unavailable Spotify items are left alone', () => { const item = wanted({ status: 'unavailable' }); assert.equal(matchCatalogueItem(item, [local('a')]), item) })

test('edition suffixes are stripped but real version markers are kept', () => {
  for (const title of ['Song - 2010 Remaster', 'Song (Remastered 2009)', 'Song - Remastered', 'Song (Deluxe Edition)', 'Song - Mono', 'Song - Stereo', 'Song - Single Version', 'Song - 2011 Remastered Version', 'Song [2015 Remaster]', 'Song (feat. Someone)', 'Song - Mono - 2009 Remaster']) assert.equal(stripEditionSuffix(title), 'Song', title)
  for (const title of ['Song - Live', 'Song (Acoustic)', 'Song - Radio Edit', 'Song (Remix)', 'Stereo Love', 'Mono']) assert.equal(stripEditionSuffix(title), title, title)
})

test('a remastered Spotify title matches the plain local title', () => {
  const item = wanted({ title: 'Birdhouse in Your Soul - 2010 Remaster', artists: ['They Might Be Giants'], album: 'Flood', duration: 200 })
  const result = matchCatalogueItem(item, [local('tmbg', { title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 })])
  assert.equal(result.status, 'available'); assert.equal(result.localTrackId, 'tmbg')
})

test('a live Spotify version still does not auto-match the studio track', () => {
  const item = wanted({ title: 'Birdhouse in Your Soul - Live', artists: ['They Might Be Giants'], album: 'Flood', duration: 200 })
  assert.equal(matchCatalogueItem(item, [local('tmbg', { title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 })]).status, 'missing')
})

test('a multi-artist track matches a local track credited to the primary artist', () => {
  const candidate = local('a', { title: 'Under Pressure', artist: 'Queen', album: 'Hot Space', duration: 248 })
  assert.equal(matchCatalogueItem(wanted({ title: 'Under Pressure', artists: ['Queen', 'David Bowie'], album: 'Hot Space', duration: 248 }), [candidate]).status, 'available')
  assert.equal(matchCatalogueItem(wanted({ title: 'Under Pressure', artists: ['Queen feat. David Bowie'], album: 'Hot Space', duration: 248 }), [candidate]).status, 'available')
  assert.equal(primaryArtist('Queen, David Bowie'), 'Queen'); assert.equal(primaryArtist('Simon & Garfunkel'), 'Simon & Garfunkel')
})

test('search uses the primary artist and bare title, then falls back to the title alone', async () => {
  assert.deepEqual(catalogueSearchQueries({ title: 'Under Pressure - Remastered 2011', artists: ['Queen', 'David Bowie'] }), ['Queen Under Pressure', 'Under Pressure'])
  const queries = []
  const candidate = local('a', { title: 'Under Pressure', artist: 'Queen', album: 'Hot Space', duration: 248 })
  const result = await findCatalogueMatch(wanted({ title: 'Under Pressure', artists: ['Queen', 'David Bowie'], album: 'Hot Space', duration: 248 }), async (query) => { queries.push(query); return query === 'Under Pressure' ? [candidate] : [] })
  assert.deepEqual(queries, ['Queen Under Pressure', 'Under Pressure']); assert.equal(result.status, 'available'); assert.equal(result.localTrackId, 'a')
})

test('search stops after the first query that finds a match', async () => {
  const queries = []
  await findCatalogueMatch(wanted(), async (query) => { queries.push(query); return [local('a')] })
  assert.deepEqual(queries, ['Zara Larsson Lush Life'])
})
