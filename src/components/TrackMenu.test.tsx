import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayNextButton, TrackMenu } from './TrackMenu'
import { usePlayer } from '../stores/player'
import type { Track } from '../types'

const api = { song: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

const song = (id: string): Track => ({ id, title: `Song ${id}`, artist: 'Artist', album: 'Album' })

describe('TrackMenu', () => {
  beforeEach(() => { usePlayer.getState().clearQueue(); api.song.mockReset() })

  it('plays a song next, after the one playing', () => {
    usePlayer.getState().playTracks([song('1'), song('2')], 0)
    render(<TrackMenu track={song('x')}/>)
    fireEvent.click(screen.getByRole('button', { name: 'More for Song x' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Play next' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['1', 'x', '2'])
    expect(screen.getByRole('status')).toHaveTextContent('Playing next')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('adds a song to the end of the queue', () => {
    usePlayer.getState().playTracks([song('1'), song('2')], 0)
    render(<TrackMenu track={song('x')}/>)
    fireEvent.click(screen.getByRole('button', { name: 'More for Song x' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['1', '2', 'x'])
  })

  it('opens song info with the full details from the server', async () => {
    api.song.mockResolvedValue({ ...song('x'), suffix: 'flac', bitDepth: 24, samplingRate: 96000, playCount: 4, path: 'Artist/Album/x.flac' })
    render(<TrackMenu track={song('x')}/>)
    fireEvent.click(screen.getByRole('button', { name: 'More for Song x' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Song info' }))
    const dialog = screen.getByRole('dialog', { name: 'Song info: Song x' })
    expect(await screen.findByText('Artist/Album/x.flac')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Hi-Res')
    expect(dialog).toHaveTextContent('FLAC · 24-bit / 96 kHz')
    expect(api.song).toHaveBeenCalledWith('x', expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Close song info' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says why song info could not load', async () => {
    api.song.mockRejectedValue(new Error('Song not found'))
    render(<TrackMenu track={song('x')}/>)
    fireEvent.click(screen.getByRole('button', { name: 'More for Song x' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Song info' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Song not found')
  })
})

describe('PlayNextButton', () => {
  beforeEach(() => usePlayer.getState().clearQueue())

  it('puts a whole album after the song playing', () => {
    vi.useFakeTimers()
    usePlayer.getState().playTracks([song('1'), song('2')], 0)
    render(<PlayNextButton tracks={[song('a'), song('b')]} label="Flood"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Play Flood next' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['1', 'a', 'b', '2'])
    expect(screen.getByRole('button', { name: 'Play Flood next' })).toHaveTextContent('Playing next')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('button', { name: 'Play Flood next' })).toHaveTextContent('Play next')
    vi.useRealTimers()
  })
})
