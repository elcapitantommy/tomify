import { describe, expect, it, vi } from 'vitest'
import { directoryResults, isHlsStream, isSecureStream, matchesAllWords, searchDirectory, searchWords } from './internet-radio'

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

  it('splits names into plain lower-case words', () => {
    expect(searchWords("  Absolute Radio 80's ")).toEqual(['absolute', 'radio', '80s'])
    expect(searchWords('Café Del Mar – Chillout')).toEqual(['cafe', 'del', 'mar', 'chillout'])
    expect(matchesAllWords('Absolute Radio 80s', ['absolute', '80s'])).toBe(true)
    expect(matchesAllWords('Absolute Radio 80s', ['80s', 'absolute'])).toBe(true)
    expect(matchesAllWords('Absolute Radio 90s', ['absolute', '80s'])).toBe(false)
  })

  it('finds stations containing every word, even with other words between them', async () => {
    const row = (id: string, name: string, clickcount: number) => ({ stationuuid: id, name, url_resolved: `https://stream.example/${id}`, lastcheckok: 1, clickcount })
    const byName: Record<string, unknown[]> = {
      'Absolute 80s': [],
      absolute: [row('a90', 'Absolute Radio 90s', 900), row('a80', 'Absolute Radio 80s', 500), row('abs', 'Absolute Radio', 800)],
      '80s': [row('a80', 'Absolute Radio 80s', 500), row('hits', '80s Hits', 1000), row('ex', 'Absolute 80s Mix', 10)],
    }
    const fetcher = vi.fn(async (input: URL) => Response.json(byName[new URL(String(input)).searchParams.get('name') ?? ''] ?? []))
    const results = await searchDirectory('Absolute 80s', undefined, fetcher as unknown as typeof fetch)
    expect(results.map((station) => station.name)).toEqual(['Absolute 80s Mix', 'Absolute Radio 80s'])
    const names = fetcher.mock.calls.map((call) => new URL(String((call as unknown as [URL])[0])).searchParams.get('name'))
    expect(names).toEqual(['Absolute 80s', 'absolute', '80s'])
  })

  it('still returns results when one of the word searches fails, and fails when all do', async () => {
    const ok = vi.fn(async (input: URL) => new URL(String(input)).searchParams.get('name') === 'absolute'
      ? Response.json([{ stationuuid: '1', name: 'Absolute Radio 80s', url_resolved: 'https://stream.example/1', lastcheckok: 1 }])
      : new Response('busy', { status: 503 }))
    expect((await searchDirectory('absolute 80s', undefined, ok as unknown as typeof fetch)).map((station) => station.id)).toEqual(['1'])
    const down = vi.fn(async () => new Response('busy', { status: 503 }))
    await expect(searchDirectory('absolute 80s', undefined, down as unknown as typeof fetch)).rejects.toThrow('could not be searched')
  })
})
