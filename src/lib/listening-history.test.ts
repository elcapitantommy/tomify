import { describe, expect, it } from 'vitest'
import { dayLabel, groupByDay, historyTrack, replayFrom, type HistoryEvent } from './listening-history'

const NOW = new Date(2026, 9, 21, 9, 0)
const play = (id: number, playedAt: number, extra: Partial<HistoryEvent> = {}): HistoryEvent => ({ id, trackId: `t${id}`, albumId: 'al', artistId: 'ar', title: `Song ${id}`, artist: 'Artist', album: 'Album', durationSeconds: 200, listenedSeconds: 200, completed: true, skipped: false, playedAt, device: 'iPhone', ...extra })

describe('listening history', () => {
  it('names days the way people say them', () => {
    expect(dayLabel(new Date(2026, 9, 21, 1).getTime(), NOW)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 20, 23).getTime(), NOW)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 18, 12).getTime(), NOW)).toMatch(/18/)
    expect(dayLabel(new Date(2025, 9, 18, 12).getTime(), NOW)).toMatch(/2025/)
  })

  it('groups plays by day and can leave out skipped songs', () => {
    const events = [play(4, new Date(2026, 9, 21, 8).getTime()), play(3, new Date(2026, 9, 21, 7).getTime(), { skipped: true, completed: false }), play(2, new Date(2026, 9, 20, 22).getTime()), play(1, new Date(2026, 9, 18, 10).getTime())]
    const days = groupByDay(events, NOW)
    expect(days.map((day) => [day.label === 'Today' || day.label === 'Yesterday' ? day.label : 'earlier', day.plays.length])).toEqual([['Today', 2], ['Yesterday', 1], ['earlier', 1]])
    const kept = groupByDay(events, NOW, true)
    expect(kept[0].plays.map((item) => item.index)).toEqual([0])
    expect(kept[1].plays[0].index).toBe(2)
  })

  it('replays a song and what was played after it, oldest first', () => {
    const events = [play(3, 3), play(2, 2), play(1, 1)]
    expect(replayFrom(events, 2).map((track) => track.id)).toEqual(['t1', 't2', 't3'])
    expect(replayFrom(events, 0).map((track) => track.id)).toEqual(['t3'])
    expect(replayFrom(events, 2, 2).map((track) => track.id)).toEqual(['t1', 't2'])
  })

  it('turns a play into something the player can play', () => {
    expect(historyTrack(play(1, 1, { title: null, artistId: null }))).toEqual({ id: 't1', title: 'Unknown song', artist: 'Artist', artistId: undefined, album: 'Album', albumId: 'al', coverArt: 'al', duration: 200 })
  })
})
