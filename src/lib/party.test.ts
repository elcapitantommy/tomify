import { describe, expect, it } from 'vitest'
import { nextPartyStep, type PartyItem } from './party'
import type { Track } from '../types'

const track = (id: string): Track => ({ id, title: id, artist: 'Artist', album: 'Album' })
const item = (id: string, state: PartyItem['state'], extra: Partial<PartyItem> = {}): PartyItem => ({ id: `item-${id}`, guestName: 'Anna', state, addedAt: 0, votes: 0, track: track(id), ...extra })

describe('nextPartyStep', () => {
  it('adds the first waiting track when no party track is up next', () => {
    expect(nextPartyStep([item('b', 'pending'), item('c', 'pending')], [track('a')], 0)).toEqual({ played: [], add: item('b', 'pending') })
  })
  it('waits while a party track is still up next, so votes can keep reordering the rest', () => {
    expect(nextPartyStep([item('b', 'queued'), item('c', 'pending')], [track('a'), track('b')], 0)).toEqual({ played: [], add: null })
  })
  it('marks the up-next track played once it starts, then adds the next one', () => {
    expect(nextPartyStep([item('b', 'queued'), item('c', 'pending')], [track('a'), track('b')], 1)).toEqual({ played: [item('b', 'queued')], add: item('c', 'pending') })
  })
  it('treats an up-next track the host removed from the queue as done', () => {
    expect(nextPartyStep([item('b', 'queued')], [track('a'), track('x')], 0)).toEqual({ played: [item('b', 'queued')], add: null })
  })
})
