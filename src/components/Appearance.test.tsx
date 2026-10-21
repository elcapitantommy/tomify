import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTheme } from '../stores/theme'
import { Appearance } from './Appearance'

describe('Appearance', () => {
  beforeEach(() => { localStorage.clear(); useTheme.setState({ mode: 'system' }) })

  it('starts on Automatic and switches to the theme picked', () => {
    render(<Appearance/>)
    expect(screen.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'false')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('tomify-theme')).toBe('light')
  })
})
