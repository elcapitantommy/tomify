import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNormalisation } from '../stores/normalisation'
import { Normalisation } from './Normalisation'

describe('Normalisation', () => {
  afterEach(() => useNormalisation.setState({ setting: 'auto' }))

  it('defaults to automatic and saves the choice for this device', () => {
    render(<Normalisation/>)
    expect(screen.getByRole('radio', { name: /^Automatic/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /^Off/ }))
    expect(useNormalisation.getState().setting).toBe('off')
    expect(JSON.parse(localStorage.getItem('tomify-normalisation')!).state.setting).toBe('off')
  })
})
