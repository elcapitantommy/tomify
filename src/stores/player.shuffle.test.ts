import { beforeEach, describe, expect, it } from 'vitest'
import { usePlayer } from './player'
import type { Track } from '../types'

const tracks: Track[] = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), title: `Song ${i + 1}`, artist: 'A', album: 'X' }))
const ids = () => usePlayer.getState().queue.map((track) => track.id)
const current = () => usePlayer.getState().queue[usePlayer.getState().currentIndex]?.id

describe('player shuffle', () => {
  beforeEach(() => { usePlayer.getState().clearQueue(); usePlayer.setState({ shuffle: false, repeat: 'off' }) })

  it('never comes back to the song that was playing when shuffle was turned on', () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      usePlayer.setState({ shuffle: false })
      usePlayer.getState().playTracks(tracks, 2)
      usePlayer.getState().toggleShuffle()
      const heard = [current()]
      for (let i = 0; i < tracks.length; i++) { usePlayer.getState().next(); if (usePlayer.getState().playing) heard.push(current()) }
      expect(heard[0]).toBe('3')
      expect(heard.filter((id) => id === '3')).toHaveLength(1)
      // Only the songs after the starting one were still to come, and each plays once.
      expect([...heard.slice(1)].sort()).toEqual(['4', '5', '6', '7', '8'])
    }
  })

  it('keeps the played tracks in place and shuffles only the upcoming ones', () => {
    usePlayer.getState().playTracks(tracks, 2)
    usePlayer.getState().toggleShuffle()
    expect(ids().slice(0, 3)).toEqual(['1', '2', '3'])
    expect(usePlayer.getState().currentIndex).toBe(2)
    expect([...ids().slice(3)].sort()).toEqual(['4', '5', '6', '7', '8'])
  })

  it('goes back to the original order from the current song when shuffle is turned off', () => {
    usePlayer.getState().playTracks(tracks, 0)
    usePlayer.getState().toggleShuffle()
    usePlayer.getState().next()
    const playing = current()
    usePlayer.getState().toggleShuffle()
    expect(ids()).toEqual(tracks.map((track) => track.id))
    expect(current()).toBe(playing)
  })

  it('starts a new list with the chosen song and plays every other song once when shuffle is already on', () => {
    usePlayer.setState({ shuffle: true })
    usePlayer.getState().playTracks(tracks, 4)
    expect(current()).toBe('5')
    expect(usePlayer.getState().currentIndex).toBe(0)
    expect([...ids()].sort()).toEqual(tracks.map((track) => track.id).sort())
  })

  it('jumping to a queued song keeps the shuffled order', () => {
    usePlayer.getState().playTracks(tracks, 0)
    usePlayer.getState().toggleShuffle()
    const order = ids()
    usePlayer.getState().playTracks(usePlayer.getState().queue, 4)
    expect(ids()).toEqual(order)
    expect(current()).toBe(order[4])
  })

  it('keeps songs added while shuffled when shuffle is turned off', () => {
    usePlayer.getState().playTracks(tracks.slice(0, 3), 0)
    usePlayer.getState().toggleShuffle()
    usePlayer.getState().addToQueue(tracks[5])
    usePlayer.getState().toggleShuffle()
    expect(ids()).toEqual(['1', '2', '3', '6'])
  })

  it('a handed-off queue keeps its order', () => {
    usePlayer.setState({ shuffle: true })
    usePlayer.getState().playTracks(tracks, 3, { keepOrder: true })
    expect(ids()).toEqual(tracks.map((track) => track.id))
    expect(current()).toBe('4')
  })
})
