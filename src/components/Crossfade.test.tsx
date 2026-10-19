import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useCrossfade } from '../stores/crossfade'
import { Crossfade } from './Crossfade'

describe('Crossfade', () => {
  afterEach(() => useCrossfade.setState({ seconds: 0 }))

  it('is off (gapless) by default and saves the length for this device', () => {
    render(<Crossfade/>)
    expect(screen.getByText('Off')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('slider', { name: 'Crossfade' }), { target: { value: '5' } })
    expect(useCrossfade.getState().seconds).toBe(5)
    expect(screen.getByText('5 seconds')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tomify-crossfade')!).state.seconds).toBe(5)
  })
})
