import { describe, expect, it } from 'vitest'
import { cleanBiography, parseArtistInfo } from './artist-info'

describe('artist info', () => {
  it('turns the Last.fm biography into plain paragraphs without the link and licence', () => {
    const html = 'They Might Be Giants are an <b>American</b> band &amp; more.<br/><br/>Formed in 1982. <a href="https://www.last.fm/music/They+Might+Be+Giants">Read more on Last.fm</a>. User-contributed text is available under the Creative Commons By-SA License; additional terms may apply.'
    expect(cleanBiography(html)).toEqual(['They Might Be Giants are an American band & more.', 'Formed in 1982.'])
    expect(cleanBiography('')).toEqual([])
    expect(cleanBiography(undefined)).toEqual([])
    expect(cleanBiography('Caf&#233; &#x26; bar')).toEqual(['Café & bar'])
  })

  it('keeps similar artists from the library but never the artist itself', () => {
    const info = parseArtistInfo({ biography: 'Hi', lastFmUrl: '', similarArtist: [{ id: 'ar1', name: 'Self' }, { id: 'ar2', name: 'Ween' }, { id: '', name: 'Not here' }] }, 'ar1')
    expect(info.similar.map((artist) => artist.name)).toEqual(['Ween'])
    expect(info.lastFmUrl).toBeUndefined()
    expect(parseArtistInfo(undefined, 'ar1')).toEqual({ biography: [], lastFmUrl: undefined, musicBrainzId: undefined, largeImageUrl: undefined, similar: [] })
  })
})
