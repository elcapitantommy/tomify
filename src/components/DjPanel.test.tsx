import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DjButton, DjPanel, DJ_TALK_MIN_MS } from './DjPanel'
import { useDj } from '../stores/dj'
import { usePlayer } from '../stores/player'
import { resetListening } from '../lib/dj-listen'

const idle = { active: false, loading: false, speaking: false, script: null, error: null, request: null, pending: null, trackIds: [] }

describe('DJ button', () => {
  const realStart = useDj.getState().start
  const realStop = useDj.getState().stop
  beforeEach(() => useDj.setState(idle))
  afterEach(() => useDj.setState({ ...idle, start: realStart, stop: realStop }))

  it('shows straight away that the DJ is starting, then offers to stop it', () => {
    const start = vi.fn(async () => { useDj.setState({ active: true, loading: true }) })
    const stop = vi.fn()
    useDj.setState({ start, stop })
    render(<DjButton/>)

    fireEvent.click(screen.getByRole('button', { name: 'DJ' }))
    expect(start).toHaveBeenCalled()
    const starting = screen.getByRole('button', { name: /Starting DJ/ })
    expect(starting).toBeDisabled()

    act(() => useDj.setState({ loading: false, trackIds: ['a', 'b'] }))
    fireEvent.click(screen.getByRole('button', { name: /Stop DJ/ }))
    expect(stop).toHaveBeenCalled()
  })

  it('keeps showing Stop DJ while the next set loads', () => {
    useDj.setState({ active: true, loading: true, trackIds: ['a'] })
    render(<DjButton/>)
    expect(screen.getByRole('button', { name: /Stop DJ/ })).toBeEnabled()
  })
})

describe('hold to talk to the DJ', () => {
  const realSteer = useDj.getState().steer
  const recognitions: { onresult: ((event: unknown) => void) | null }[] = []
  class FakeRecognition {
    onresult = null; onerror = null; onend: (() => void) | null = null; lang = ''; continuous = false; interimResults = false
    start() {}
    stop() { this.onend?.() }
    abort() {}
    constructor() { recognitions.push(this) }
  }
  const say = (text: string) => act(() => recognitions.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }))
  let clock = 0
  beforeEach(() => {
    resetListening()
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    useDj.setState({ ...idle, active: true, trackIds: ['a'], script: 'Morning Tom.' })
    usePlayer.setState({ playing: true })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); useDj.setState({ ...idle, steer: realSteer }); delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition })

  it('pauses the music while you talk, then asks the DJ to play it straight away', async () => {
    const steer = vi.fn(async () => true)
    useDj.setState({ steer })
    render(<DjPanel/>)
    const mic = screen.getByRole('button', { name: 'Hold to talk to the DJ' })
    fireEvent.pointerDown(mic, { pointerId: 1 })
    expect(usePlayer.getState().playing).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Listening…')
    say('something upbeat')
    expect(screen.getByRole('status')).toHaveTextContent('something upbeat')
    clock += 1500
    await act(async () => { fireEvent.pointerUp(mic, { pointerId: 1 }) })
    expect(steer).toHaveBeenCalledWith('something upbeat', { now: true })
  })

  it('puts the music back on when nothing was heard, or the button was only tapped', async () => {
    const steer = vi.fn(async () => true)
    useDj.setState({ steer })
    render(<DjPanel/>)
    const mic = screen.getByRole('button', { name: 'Hold to talk to the DJ' })
    fireEvent.pointerDown(mic, { pointerId: 1 })
    clock += DJ_TALK_MIN_MS - 1
    await act(async () => { fireEvent.pointerUp(mic, { pointerId: 1 }) })
    expect(screen.getByRole('status')).toHaveTextContent('Hold the button down while you talk')
    expect(usePlayer.getState().playing).toBe(true)

    fireEvent.pointerDown(mic, { pointerId: 1 })
    clock += 2000
    await act(async () => { fireEvent.pointerUp(mic, { pointerId: 1 }) })
    expect(screen.getByRole('status')).toHaveTextContent('The DJ didn\'t catch that')
    expect(usePlayer.getState().playing).toBe(true)
    expect(steer).not.toHaveBeenCalled()
  })
})
