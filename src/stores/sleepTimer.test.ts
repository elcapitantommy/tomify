import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from './player'
import { sleepTimerLabel, takeTrackEnd, useSleepTimer } from './sleepTimer'
import type { Track } from '../types'

const tracks: Track[] = [{ id: '1', title: 'One', artist: 'A', album: 'X' }, { id: '2', title: 'Two', artist: 'A', album: 'X' }]

describe('sleep timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePlayer.getState().clearQueue()
    usePlayer.getState().playTracks(tracks)
  })
  afterEach(() => { useSleepTimer.getState().cancel(); vi.useRealTimers() })

  it('pauses playback once the chosen minutes are up', () => {
    useSleepTimer.getState().startMinutes(15)
    expect(sleepTimerLabel(useSleepTimer.getState().timer)).toBe('Stops in 15 min')
    vi.advanceTimersByTime(14 * 60_000)
    expect(usePlayer.getState().playing).toBe(true)
    expect(sleepTimerLabel(useSleepTimer.getState().timer)).toBe('Stops in under a minute')
    vi.advanceTimersByTime(60_000)
    expect(usePlayer.getState().playing).toBe(false)
    expect(useSleepTimer.getState().timer).toBeNull()
  })

  it('also stops on the next progress update when a hidden page held the timer back', () => {
    useSleepTimer.getState().startMinutes(30)
    vi.setSystemTime(Date.now() + 31 * 60_000)
    usePlayer.getState().setProgress(12, 200)
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('can be turned off or replaced', () => {
    useSleepTimer.getState().startMinutes(15)
    useSleepTimer.getState().startMinutes(60)
    vi.advanceTimersByTime(20 * 60_000)
    expect(usePlayer.getState().playing).toBe(true)
    useSleepTimer.getState().cancel()
    vi.advanceTimersByTime(60 * 60_000)
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('takes the end of the song once when set to the end of this song', () => {
    expect(takeTrackEnd()).toBe(false)
    useSleepTimer.getState().startEndOfTrack()
    expect(sleepTimerLabel(useSleepTimer.getState().timer)).toBe('Stops after this song')
    expect(takeTrackEnd()).toBe(true)
    expect(takeTrackEnd()).toBe(false)
  })

  it('moves to the next song without starting it', () => {
    usePlayer.getState().next({ pause: true })
    expect(usePlayer.getState().currentIndex).toBe(1)
    expect(usePlayer.getState().playing).toBe(false)
  })
})
