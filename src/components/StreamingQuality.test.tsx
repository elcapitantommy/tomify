import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStreamQuality } from '../stores/streamQuality'
import { StreamingQuality } from './StreamingQuality'

describe('StreamingQuality', () => {
  afterEach(() => useStreamQuality.setState({ quality: 'adaptive' }))

  it('defaults to adaptive and saves the chosen quality for this device', () => {
    render(<StreamingQuality/>)
    expect(screen.getByRole('radio', { name: /^Adaptive/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /Original on Wi-Fi/ }))
    expect(useStreamQuality.getState().quality).toBe('original-on-wifi')
    expect(JSON.parse(localStorage.getItem('tomify-stream-quality')!).state.quality).toBe('original-on-wifi')
  })
})
