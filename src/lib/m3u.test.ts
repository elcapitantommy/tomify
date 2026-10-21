import { describe, expect, it } from 'vitest'
import type { Track } from '../types'
import { buildM3u, entryFromPath, m3uFileName, parseM3u } from './m3u'

const tracks: Track[] = [
  { id: 't1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 197.4, path: 'They Might Be Giants/Flood/03 - Birdhouse in Your Soul.flac' },
  { id: 't2', title: 'What/Ever?', artist: 'Muse', album: 'Absolution', duration: 200, track: 4, suffix: 'mp3' },
]

describe('M3U files', () => {
  it('writes an extended M3U with the library paths', () => {
    expect(buildM3u('Road trip', tracks)).toBe([
      '#EXTM3U', '#PLAYLIST:Road trip',
      '#EXTINF:197,They Might Be Giants - Birdhouse in Your Soul', '#EXTALB:Flood', 'They Might Be Giants/Flood/03 - Birdhouse in Your Soul.flac',
      '#EXTINF:200,Muse - What/Ever?', '#EXTALB:Absolution', 'Muse/Absolution/04 - What_Ever_.mp3', '',
    ].join('\n'))
  })

  it('names the file safely', () => {
    expect(m3uFileName('AC/DC: best?')).toBe('AC DC best.m3u8')
    expect(m3uFileName('  ')).toBe('Playlist.m3u8')
  })

  it('reads back what it writes', () => {
    const parsed = parseM3u(buildM3u('Road trip', tracks))
    expect(parsed.name).toBe('Road trip')
    expect(parsed.entries).toEqual([
      { title: 'Birdhouse in Your Soul', artists: ['They Might Be Giants'], album: 'Flood', duration: 197, path: 'They Might Be Giants/Flood/03 - Birdhouse in Your Soul.flac' },
      { title: 'What/Ever?', artists: ['Muse'], album: 'Absolution', duration: 200, path: 'Muse/Absolution/04 - What_Ever_.mp3' },
    ])
  })

  it('reads plain lists of paths from other players, Windows paths and file URLs, and skips streams', () => {
    const parsed = parseM3u('\uFEFFC:\\Music\\Muse\\Absolution\\01. Intro.flac\r\nhttps://radio.example/stream\r\n#EXTINF:-1,Live radio\r\nhttp://radio.example/other\r\nfile:///home/tom/Music/Blur%20-%20Song%202.mp3\r\n')
    expect(parsed.entries).toEqual([
      { title: 'Intro', artists: ['Muse'], album: 'Absolution', duration: undefined, path: 'C:/Music/Muse/Absolution/01. Intro.flac' },
      { title: 'Song 2', artists: ['Blur'], album: undefined, duration: undefined, path: '/home/tom/Music/Blur - Song 2.mp3' },
    ])
  })

  it('guesses from a file name', () => {
    expect(entryFromPath('Blur - Song 2.mp3')).toEqual({ title: 'Song 2', artists: ['Blur'], path: 'Blur - Song 2.mp3' })
    expect(entryFromPath('Muse/Absolution/1-03 Time Is Running Out.flac')).toMatchObject({ title: 'Time Is Running Out', artists: ['Muse'], album: 'Absolution' })
    expect(entryFromPath('Muse/Absolution/03 - Muse - Hysteria.flac')).toMatchObject({ title: 'Hysteria', artists: ['Muse'], album: 'Absolution' })
    expect(entryFromPath('Muse/HAARP/03 - Hysteria - Live.flac')).toMatchObject({ title: 'Hysteria - Live', artists: ['Muse'], album: 'HAARP' })
  })
})
