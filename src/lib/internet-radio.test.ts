import { describe, expect, it, vi } from 'vitest'
import { directoryResults, isHlsStream, isSecureStream, searchDirectory } from './internet-radio'

describe('internet radio', () => {
  it('only offers working https streams from the directory, once each', () => {
    const rows = [
      { stationuuid: '1', name: 'BBC Radio 6 Music', url_resolved: 'https://stream.example/6music.m3u8', homepage: 'https://bbc.co.uk/6music', country: 'United Kingdom', tags: 'indie,alternative', codec: 'AAC', bitrate: 128, lastcheckok: 1 },
      { stationuuid: '2', name: 'Plain http', url_resolved: 'http://stream.example/radio.mp3', lastcheckok: 1 },
      { stationuuid: '3', name: 'Broken', url_resolved: 'https://stream.example/broken', lastcheckok: 0 },
      { stationuuid: '4', name: 'Same stream again', url_resolved: 'https://stream.example/6music.m3u8', lastcheckok: 1 },
      { stationuuid: '5', name: '  ', url_resolved: 'https://stream.example/noname' },
    ]
    expect(directoryResults(rows)).toEqual([{ id: '1', name: 'BBC Radio 6 Music', streamUrl: 'https://stream.example/6music.m3u8', homePageUrl: 'https://bbc.co.uk/6music', country: 'United Kingdom', tags: ['indie', 'alternative'], codec: 'AAC', bitrate: 128, favicon: undefined }])
    expect(isSecureStream('http://x.example/a')).toBe(false)
    expect(isSecureStream('not a url')).toBe(false)
    expect(isHlsStream('https://x.example/live.m3u8?token=1')).toBe(true)
    expect(isHlsStream('https://x.example/live.mp3')).toBe(false)
  })

  it('searches Radio Browser by name, most played first', async () => {
    const fetcher = vi.fn(async () => Response.json([]))
    await searchDirectory('6 music', undefined, fetcher as unknown as typeof fetch)
    const url = new URL(String((fetcher.mock.calls[0] as unknown as [URL])[0]))
    expect(url.hostname).toBe('all.api.radio-browser.info')
    expect(url.searchParams.get('name')).toBe('6 music')
    expect(url.searchParams.get('order')).toBe('clickcount')
    expect(url.searchParams.get('hidebroken')).toBe('true')
  })
})
