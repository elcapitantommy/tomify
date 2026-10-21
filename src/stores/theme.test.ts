import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, resolveTheme, useTheme, watchSystemTheme } from './theme'

function stubSystem(light: boolean) {
  const listeners: (() => void)[] = []
  const query = { matches: light, addEventListener: (_: string, listener: () => void) => listeners.push(listener), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return { query, change(next: boolean) { query.matches = next; listeners.forEach((listener) => listener()) } }
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.head.innerHTML = '<meta name="theme-color" content="#0d0f0e">'
    useTheme.setState({ mode: 'system' })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('follows the device unless light or dark is chosen', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('sets the page theme and browser bar colour, and remembers the choice on this device', () => {
    stubSystem(false)
    useTheme.getState().setMode('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.querySelector('meta[name=theme-color]')).toHaveAttribute('content', '#f0f2f1')
    expect(localStorage.getItem('tomify-theme')).toBe('light')
    applyTheme('dark')
    expect(document.querySelector('meta[name=theme-color]')).toHaveAttribute('content', '#0d0f0e')
  })

  it('switches with the device while on Automatic, and not otherwise', () => {
    const system = stubSystem(false)
    applyTheme('system')
    const stop = watchSystemTheme()
    system.change(true)
    expect(document.documentElement.dataset.theme).toBe('light')
    useTheme.getState().setMode('dark')
    system.change(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    stop()
  })
})
