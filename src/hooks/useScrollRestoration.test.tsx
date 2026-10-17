import { act, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESTORE_TIMEOUT_MS, resetScrollPositions, useScrollRestoration } from './useScrollRestoration'

let pageHeight = 5000
let scrollY = 0

function setScroll(y: number) {
  scrollY = Math.max(0, Math.min(y, pageHeight - window.innerHeight))
  window.dispatchEvent(new Event('scroll'))
}

function Shell({ children }: { children: React.ReactNode }) { useScrollRestoration(); return <>{children}</> }
function BackButton() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>Back</button> }

function renderApp() {
  return render(<MemoryRouter initialEntries={['/artists']}><Shell><Routes>
    <Route path="/artists" element={<Link to="/artists/1">Artist one</Link>}/>
    <Route path="/artists/:id" element={<BackButton/>}/>
  </Routes></Shell></MemoryRouter>)
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

describe('useScrollRestoration', () => {
  beforeEach(() => {
    resetScrollPositions()
    pageHeight = 5000
    scrollY = 0
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => pageHeight })
    vi.spyOn(window, 'scrollTo').mockImplementation(((x: number, y: number) => setScroll(y)) as typeof window.scrollTo)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('starts a newly opened page at the top and restores the list position on Back', async () => {
    renderApp()
    act(() => setScroll(2400))
    fireEvent.click(screen.getByRole('link', { name: 'Artist one' }))
    expect(scrollY).toBe(0)
    act(() => setScroll(300))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(scrollY).toBe(2400)
  })

  it('waits for a page that is still loading to grow tall enough before restoring', async () => {
    renderApp()
    act(() => setScroll(2400))
    fireEvent.click(screen.getByRole('link', { name: 'Artist one' }))
    pageHeight = 900
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(scrollY).toBe(0)
    act(() => setScroll(scrollY))
    await nextFrame()
    pageHeight = 5000
    await nextFrame()
    await nextFrame()
    expect(scrollY).toBe(2400)
  })

  it('stops waiting when the user scrolls themselves', async () => {
    renderApp()
    act(() => setScroll(2400))
    fireEvent.click(screen.getByRole('link', { name: 'Artist one' }))
    pageHeight = 900
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.wheel(window)
    pageHeight = 5000
    await nextFrame()
    await nextFrame()
    expect(scrollY).toBe(0)
  })

  it('gives up after a timeout and keeps as close as the page allows', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    renderApp()
    act(() => setScroll(2400))
    fireEvent.click(screen.getByRole('link', { name: 'Artist one' }))
    pageHeight = 1500
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    now.mockReturnValue(1000 + RESTORE_TIMEOUT_MS)
    await nextFrame()
    await nextFrame()
    expect(scrollY).toBe(1500 - window.innerHeight)
  })
})
