import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { useLiveRadio } from '../stores/liveRadio'
import { usePlayer } from '../stores/player'
import { LiveRadioRuntime } from '../components/LiveRadio'
import { Radio } from './Radio'

let user = 0
const station = { id: 'r1', name: 'Radio Paradise', streamUrl: 'https://stream.example/rp.mp3', homePageUrl: 'https://radioparadise.com' }
const api = { session: { username: 'tom' }, radioStations: vi.fn(async () => [station]), addRadioStation: vi.fn(async () => undefined), deleteRadioStation: vi.fn(async () => undefined) }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

describe('Radio', () => {
  beforeEach(() => {
    api.session.username = `user${++user}`
    vi.clearAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    useLiveRadio.getState().stop()
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('plays a station, pausing the music, and music playing stops the station', async () => {
    usePlayer.setState({ queue: [{ id: 'a', title: 'Ana Ng', artist: 'TMBG', album: 'Lincoln' }], currentIndex: 0, playing: true })
    render(<><Radio/><LiveRadioRuntime/></>)
    const play = await screen.findByRole('button', { name: 'Play Radio Paradise' })
    await act(async () => { fireEvent.click(play) })
    expect(useLiveRadio.getState().station?.id).toBe('r1')
    expect(usePlayer.getState().playing).toBe(false)
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('https://stream.example/rp.mp3')
    expect(screen.getByRole('button', { name: 'Stop Radio Paradise' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Radio Paradise' })).not.toBeInTheDocument()
    await act(async () => { usePlayer.getState().setPlaying(true) })
    expect(useLiveRadio.getState().station).toBeNull()
  })

  it('lets an administrator find a station in the directory and add it', async () => {
    useAuth.setState({ isAdmin: true })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ stationuuid: 'd1', name: 'BBC Radio 6 Music', url_resolved: 'https://stream.example/6music.mp3', lastcheckok: 1 }])))
    render(<Radio/>)
    await screen.findByText('Radio Paradise')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search radio stations' }), { target: { value: '6 music' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Search' })) })
    const add = await screen.findByRole('button', { name: 'Add BBC Radio 6 Music' })
    await act(async () => { fireEvent.click(add) })
    expect(api.addRadioStation).toHaveBeenCalledWith({ name: 'BBC Radio 6 Music', streamUrl: 'https://stream.example/6music.mp3', homePageUrl: undefined })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Radio Paradise' })) })
    expect(api.deleteRadioStation).toHaveBeenCalledWith('r1')
  })

  it('refuses plain http links, which browsers block', async () => {
    useAuth.setState({ isAdmin: true })
    render(<Radio/>)
    await screen.findByText('Radio Paradise')
    fireEvent.change(screen.getByRole('textbox', { name: 'Station name' }), { target: { value: 'Old' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Stream link' }), { target: { value: 'http://old.example/stream' } })
    expect(screen.getByRole('button', { name: 'Add station' })).toBeDisabled()
    expect(screen.getByText(/browsers block http radio streams/)).toBeInTheDocument()
  })
})
