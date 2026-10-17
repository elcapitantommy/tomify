import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DjButton } from './DjPanel'
import { useDj } from '../stores/dj'

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
