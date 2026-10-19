import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeLine, loadLyrics, lyricsFrom, parseLrc } from './lyrics'
import type { NavidromeClient } from './navidrome'
import { useAuth } from '../stores/auth'

describe('lyrics', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads LRC stamps, repeated stamps and the offset, skipping tag lines', () => {
    const lines = parseLrc('[ar:Someone]\n[offset:+500]\n[00:12.50]First\n[00:05.00][01:00.25]Chorus\n[00:20]\nnot a lyric')
    expect(lines).toEqual([
      { time: 4.5, text: 'Chorus' },
      { time: 12, text: 'First' },
      { time: 19.5, text: '' },
      { time: 59.75, text: 'Chorus' },
    ])
  })

  it('finds the line being sung', () => {
    const lines = parseLrc('[00:01.00]a\n[00:03.00]b\n[00:07.00]c')
    expect(activeLine(lines, 0.5)).toBe(-1)
    expect(activeLine(lines, 1)).toBe(0)
    expect(activeLine(lines, 6.9)).toBe(1)
    expect(activeLine(lines, 300)).toBe(2)
  })

  it('prefers synced lyrics and falls back to plain ones', () => {
    expect(lyricsFrom({ synced: '[00:01.00]hi', plain: 'hi' })).toEqual({ synced: true, lines: [{ time: 1, text: 'hi' }] })
    expect(lyricsFrom({ synced: null, plain: 'one\ntwo' })).toEqual({ synced: false, lines: [{ time: -1, text: 'one' }, { time: -1, text: 'two' }] })
    expect(lyricsFrom({ synced: null, plain: null })).toBeNull()
  })

  it("uses Navidrome's lyrics first and asks the Worker only when it has none, once per song", async () => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' } })
    const fetcher = vi.fn(async (url: string) => { void url; return Response.json({ synced: '[00:02.00]From LRCLIB', plain: null }) })
    vi.stubGlobal('fetch', fetcher)
    const own = { synced: true, lines: [{ time: 1, text: 'From the file' }] }
    const api = { lyrics: vi.fn(async (id: string) => id === 'tagged' ? own : null) } as unknown as NavidromeClient

    expect(await loadLyrics(api, { id: 'tagged', title: 'A', artist: 'B', album: 'C' })).toBe(own)
    expect(fetcher).not.toHaveBeenCalled()

    const track = { id: 'untagged', title: 'Song & Dance', artist: 'B', album: 'C', duration: 201.6 }
    expect(await loadLyrics(api, track)).toEqual({ synced: true, lines: [{ time: 2, text: 'From LRCLIB' }] })
    await loadLyrics(api, track)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://app.example')
    expect(url.pathname).toBe('/api/lyrics')
    expect(Object.fromEntries(url.searchParams)).toEqual({ id: 'untagged', artist: 'B', title: 'Song & Dance', duration: '202' })
  })

  it('treats a server without the lyrics endpoint as having none', async () => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' } })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ synced: null, plain: null })))
    const api = { lyrics: vi.fn(async () => { throw new Error('Unknown endpoint') }) } as unknown as NavidromeClient
    expect(await loadLyrics(api, { id: 'old-server', title: 'A', artist: 'B', album: 'C' })).toBeNull()
  })
})
