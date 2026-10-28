import { describe, expect, it } from 'vitest'
import * as Q from './queue'
import type { TomTubeVideo } from './api'

const video = (id: string, duration = 100): TomTubeVideo => ({ id: id.padEnd(11, '_'), title: `Title ${id}`, channel: 'Channel', duration })
const ids = (state: Q.QueueState) => state.items.map((item) => item.id[0])

describe('TomTube queue', () => {
  it('starts with the first video played', () => {
    const state = Q.playNow(Q.emptyQueue, video('a'))
    expect(state).toEqual({ items: [video('a')], index: 0 })
    expect(Q.current(state)?.id).toBe(video('a').id)
    expect(Q.current(Q.emptyQueue)).toBeNull()
  })

  it('adds to the end, plays next straight after the current video, and plays now in place', () => {
    let state = Q.addToQueue(Q.playNow(Q.emptyQueue, video('a')), video('b'))
    state = Q.addToQueue(state, video('c'))
    state = Q.playNext(state, video('d'))
    expect(ids(state)).toEqual(['a', 'd', 'b', 'c'])
    expect(state.index).toBe(0)
    state = Q.playNow(state, video('e'))
    expect(ids(state)).toEqual(['a', 'e', 'd', 'b', 'c'])
    expect(Q.current(state)?.id[0]).toBe('e')
    expect(Q.upcoming(state).map((item) => item.id[0])).toEqual(['d', 'b', 'c'])
    expect(Q.addToQueue(Q.emptyQueue, video('x')).index).toBe(0)
    expect(Q.playNext(Q.emptyQueue, video('x')).index).toBe(0)
  })

  it('moves forward and back and stops at either end', () => {
    const state = { items: [video('a'), video('b')], index: 0 }
    const second = Q.next(state)!
    expect(second.index).toBe(1)
    expect(Q.next(second)).toBeNull()
    expect(Q.previous(second)?.index).toBe(0)
    expect(Q.previous(state)).toBeNull()
    expect(Q.jumpTo(state, 1).index).toBe(1)
    expect(Q.jumpTo(state, 9)).toBe(state)
  })

  it('removes and reorders without losing the current video', () => {
    const state = { items: [video('a'), video('b'), video('c'), video('d')], index: 2 }
    expect(Q.removeAt(state, 2)).toBe(state)
    const removed = Q.removeAt(state, 0)
    expect(ids(removed)).toEqual(['b', 'c', 'd'])
    expect(Q.current(removed)?.id[0]).toBe('c')
    expect(Q.current(Q.removeAt(state, 3))?.id[0]).toBe('c')
    expect(Q.current(Q.move(state, 2, 0))?.id[0]).toBe('c')
    expect(Q.current(Q.move(state, 0, 3))?.id[0]).toBe('c')
    expect(Q.current(Q.move(state, 3, 0))?.id[0]).toBe('c')
    expect(ids(Q.move(state, 3, 0))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(Q.clearUpcoming(state))).toEqual(['a', 'b', 'c'])
  })

  it('keeps recently watched newest first, once per video, and bounded', () => {
    let history: Q.HistoryEntry[] = []
    history = Q.recordHistory(history, video('a'), 1)
    history = Q.recordHistory(history, video('b'), 2)
    history = Q.recordHistory(history, video('a'), 3)
    expect(history.map((entry) => entry.id[0])).toEqual(['a', 'b'])
    expect(history[0].watchedAt).toBe(3)
    for (let index = 0; index < 150; index += 1) history = Q.recordHistory(history, video(`v${index}`), index)
    expect(history).toHaveLength(Q.HISTORY_LIMIT)
  })

  it('resumes where a video was left, except near the start or end', () => {
    const history = Q.updatePosition(Q.recordHistory([], video('a', 600)), video('a').id, 200)
    expect(Q.resumePosition(history[0], 600)).toBe(200)
    expect(Q.resumePosition({ ...history[0], position: 10 }, 600)).toBe(0)
    expect(Q.resumePosition({ ...history[0], position: 590 }, 600)).toBe(0)
    expect(Q.resumePosition(undefined, 600)).toBe(0)
  })
})
