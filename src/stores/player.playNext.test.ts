import { beforeEach, describe, expect, it } from 'vitest'
import { usePlayer } from './player'
import { applyCommand } from './playbackHandoff'
import type { Track } from '../types'

const song = (id: string): Track => ({ id, title: `Song ${id}`, artist: 'A', album: 'X' })

describe('play next', () => {
  beforeEach(() => { usePlayer.getState().clearQueue(); usePlayer.setState({ shuffle: false, unshuffledQueue: null }) })

  it('puts songs straight after the one playing, in order, without changing what plays now', () => {
    usePlayer.getState().playTracks([song('1'), song('2'), song('3')], 1)
    usePlayer.getState().playNext([song('a'), song('b')])
    const state = usePlayer.getState()
    expect(state.queue.map((track) => track.id)).toEqual(['1', '2', 'a', 'b', '3'])
    expect(state.currentIndex).toBe(1)
    usePlayer.getState().next()
    expect(usePlayer.getState().queue[usePlayer.getState().currentIndex].id).toBe('a')
  })

  it('starts playing when nothing is queued', () => {
    usePlayer.getState().playNext([song('a'), song('b')])
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['a', 'b'])
    expect(usePlayer.getState().currentIndex).toBe(0)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('keeps the songs next in the original order too, so turning shuffle off keeps them', () => {
    usePlayer.getState().playTracks([song('1'), song('2'), song('3'), song('4')], 0)
    usePlayer.setState({ shuffle: true, queue: [song('1'), song('4'), song('2'), song('3')], unshuffledQueue: [song('1'), song('2'), song('3'), song('4')], currentIndex: 0 })
    usePlayer.getState().playNext([song('a')])
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['1', 'a', '4', '2', '3'])
    expect(usePlayer.getState().unshuffledQueue?.map((track) => track.id)).toEqual(['1', 'a', '2', '3', '4'])
  })

  it('runs a play-next command sent from another device', () => {
    usePlayer.getState().playTracks([song('1'), song('2')], 0)
    applyCommand({ revision: 1, targetDeviceId: 'here', action: 'play-next', tracks: [song('a')], updatedAt: 1 }, null)
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['1', 'a', '2'])
  })
})
