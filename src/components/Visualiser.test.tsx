import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisualiser } from '../stores/visualiser'
import { Visualiser, VisualiserButton } from './Visualiser'

const api = { streamsSameOrigin: vi.fn(() => true) }
vi.mock('../lib/api-context', () => ({ useOptionalApi: () => api }))

describe('Visualiser', () => {
  beforeEach(() => {
    useVisualiser.setState({ mode: 'off' })
    api.streamsSameOrigin.mockReturnValue(true)
    vi.stubGlobal('AudioContext', class {})
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('cycles Off, Bars and Wave from the Now Playing button, and remembers it on this device', () => {
    render(<VisualiserButton/>)
    const button = screen.getByRole('button', { name: 'Visualiser: Off' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Visualiser: Bars' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Visualiser: Bars' }))
    expect(screen.getByRole('button', { name: 'Visualiser: Wave' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tomify-visualiser')!).state.mode).toBe('wave')
  })

  it('draws on a canvas only while switched on and playing here', () => {
    const { container, rerender } = render(<Visualiser/>)
    expect(container.querySelector('canvas')).toBeNull()
    act(() => useVisualiser.getState().setMode('bars'))
    expect(container.querySelector('canvas.visualiser.bars')).not.toBeNull()
    rerender(<Visualiser active={false}/>)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('is not offered on iPhone or iPad, or when music streams from another server', () => {
    api.streamsSameOrigin.mockReturnValue(false)
    const { rerender } = render(<VisualiserButton/>)
    expect(screen.queryByRole('button', { name: /Visualiser/ })).toBeNull()
    api.streamsSameOrigin.mockReturnValue(true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    rerender(<VisualiserButton key="again"/>)
    expect(screen.queryByRole('button', { name: /Visualiser/ })).toBeNull()
    vi.restoreAllMocks()
  })
})
