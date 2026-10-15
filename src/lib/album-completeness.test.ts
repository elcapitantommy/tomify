import { assessAlbumCompleteness, completenessText, distinctLocalTrackCount, editionLabel, titleSimilarity, type TracklistTrack } from './album-completeness'
import type { Track } from '../types'

const floodTitles = ['Theme From Flood', 'Birdhouse in Your Soul', 'Lucky Ball and Chain', 'Istanbul (Not Constantinople)', 'Dead', 'Your Racist Friend', 'Particle Man', 'Twisting', 'We Want a Rock', 'Someone Keeps Moving My Chair', 'Hearing Aid', 'Minimum Wage', 'Letterbox', 'Whistling in the Dark', 'Hot Cha', 'Women & Men', 'Sapphire Bullets of Pure Love', 'They Might Be Giants', 'Road Movie to Berlin']
const flood: TracklistTrack[] = floodTitles.map((title, index) => ({ key: `1-${index + 1}`, disc: 1, number: index + 1, title, artist: 'They Might Be Giants', length: 120 + index, recordingId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }))
const local = (id: string, patch: Partial<Track>): Track => ({ id, title: '', artist: 'They Might Be Giants', album: 'Flood', ...patch })

describe('album completeness', () => {
  it('reports the Flood single-track recovery as 1 of 19 with the other 18 missing', () => {
    const result = assessAlbumCompleteness({ tracks: flood }, [local('a', { title: 'Birdhouse In Your Soul', duration: 121 })])
    expect(result.present).toBe(1)
    expect(result.total).toBe(19)
    expect(result.complete).toBe(false)
    expect(result.missing).toHaveLength(18)
    expect(result.missing.map((track) => track.key)).not.toContain('1-2')
  })

  it('treats a full release as complete and matches by recording ID before position', () => {
    const tracks = flood.map((track, index) => local(`t${index}`, { title: track.title, track: 19 - index, musicBrainzId: track.recordingId ?? undefined }))
    const result = assessAlbumCompleteness({ tracks: flood }, tracks)
    expect(result.complete).toBe(true)
    expect(result.matches.every((match) => match.local.length === 1 && match.local[0].title === match.track.title)).toBe(true)
  })

  it('matches by disc and track number when titles differ only by tagging style', () => {
    const result = assessAlbumCompleteness({ tracks: flood.slice(0, 4) }, [local('x', { title: 'Istanbul', track: 4, duration: 123 })])
    expect(result.matches[3].local.map((track) => track.id)).toEqual(['x'])
  })

  it('ignores remaster suffixes when matching by title', () => {
    expect(titleSimilarity('Particle Man - 2013 Remaster', 'Particle Man')).toBe(1)
    expect(titleSimilarity('Dead (Remastered)', 'Dead')).toBe(1)
    const result = assessAlbumCompleteness({ tracks: flood }, [local('p', { title: 'Particle Man - Remastered 2013', duration: 126 })])
    expect(result.matches[6].local).toHaveLength(1)
  })

  it('does not match a different song with the same position but an unrelated title and duration', () => {
    const result = assessAlbumCompleteness({ tracks: flood.slice(0, 3) }, [local('z', { title: 'Ana Ng', track: 1, duration: 200 })])
    expect(result.present).toBe(0)
    expect(result.extras.map((track) => track.id)).toEqual(['z'])
  })

  it('counts master and recovery copies of one track as a duplicate, not as two tracks', () => {
    const result = assessAlbumCompleteness({ tracks: flood }, [local('master', { title: 'Dead', track: 5, duration: 124 }), local('recovery', { title: 'Dead', duration: 124 })])
    expect(result.present).toBe(1)
    expect(result.duplicated).toBe(1)
    expect(distinctLocalTrackCount([local('a', { title: 'Dead' }), local('b', { title: 'Dead (Remastered)' })])).toBe(1)
  })

  it('keeps disc numbers distinct on multi-disc releases', () => {
    const tracks: TracklistTrack[] = [{ key: '1-1', disc: 1, number: 1, title: 'Intro', artist: null, length: 60, recordingId: null }, { key: '2-1', disc: 2, number: 1, title: 'Outro', artist: null, length: 90, recordingId: null }]
    const result = assessAlbumCompleteness({ tracks }, [local('d2', { title: 'Outro', track: 1, discNumber: 2, duration: 90 })])
    expect(result.matches[0].local).toHaveLength(0)
    expect(result.matches[1].local).toHaveLength(1)
  })

  it('normalises non-Latin titles instead of erasing them', () => {
    expect(completenessText('ガッチャマン')).toBe('ガッチャマン')
    expect(completenessText('Björk')).toBe('bjork')
    expect(titleSimilarity('ガッチャマン', 'ガッチャマン')).toBe(1)
  })

  it('labels editions compactly', () => {
    expect(editionLabel({ date: '1990-01-15', country: 'US', format: 'CD', disambiguation: null, trackCount: 19 })).toBe('1990 · US · CD · 19 tracks')
  })
})
