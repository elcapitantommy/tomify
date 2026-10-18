import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_NAVIDROME_SERVER } from '../lib/navidrome'
import { useAuth } from '../stores/auth'
import { useEqualiser } from '../stores/equaliser'
import { Equaliser } from './Equaliser'

describe('Equaliser', () => {
  beforeEach(() => useAuth.setState({ session: { serverUrl: DEFAULT_NAVIDROME_SERVER, username: 'tom', salt: 's', token: 't' } }))
  afterEach(() => useEqualiser.setState({ enabled: false, preset: 'flat', gains: Array(10).fill(0) }))

  it('is off by default, and switching it on shows presets and bands saved for this device', () => {
    render(<Equaliser supported/>)
    expect(screen.queryByLabelText('62 Hz gain')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Use the equaliser/ }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bass' } })
    expect(useEqualiser.getState().gains.slice(0, 3)).toEqual([6, 5, 4])
    fireEvent.change(screen.getByLabelText('16 kHz gain'), { target: { value: '3' } })
    expect(useEqualiser.getState().preset).toBe('custom')
    expect(screen.getByText('+3 dB')).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem('tomify-equaliser')!).state
    expect(saved).toEqual({ enabled: true, preset: 'custom', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 3] })
  })

  it('explains why it is missing on iPhone and with another music server', () => {
    const { unmount } = render(<Equaliser supported={false}/>)
    expect(screen.getByText(/Not available on iPhone or iPad/)).toBeInTheDocument()
    unmount()
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' } })
    render(<Equaliser supported/>)
    expect(screen.getByText(/Only available with the Tomify music server/)).toBeInTheDocument()
  })
})
