import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { NavidromeClient } from '../lib/navidrome'
import { LibraryScan, SCAN_POLL_MS } from './LibraryScan'

const api = { scanStatus: vi.fn(), startScan: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api as unknown as NavidromeClient }))

describe('LibraryScan', () => {
  afterEach(() => { vi.useRealTimers(); api.scanStatus.mockReset(); api.startScan.mockReset() })

  it('starts a full scan and follows it until Navidrome finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.scanStatus.mockResolvedValueOnce({ scanning: false, lastScan: '2026-10-15T10:00:00Z' }).mockResolvedValueOnce({ scanning: false, count: 5120 })
    api.startScan.mockResolvedValue({ scanning: true, count: 12 })
    render(<MemoryRouter><LibraryScan/></MemoryRouter>)
    expect(screen.getByRole('link', { name: /Library health/ })).toHaveAttribute('href', '/library-health')
    fireEvent.click(await screen.findByRole('button', { name: 'Scan library' }))
    expect(api.startScan).toHaveBeenCalledWith(true)
    expect(await screen.findByRole('button', { name: /Scanning/ })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS) })
    expect(await screen.findByRole('button', { name: 'Scan library' })).toBeEnabled()
    expect(api.scanStatus).toHaveBeenCalledTimes(2)
  })

  it('recovers when a status check never answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // The first check hangs, as a request does when a phone suspends the app; the next one must still run.
    api.scanStatus.mockResolvedValueOnce({ scanning: false }).mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ scanning: false })
    api.startScan.mockResolvedValue({ scanning: true })
    render(<MemoryRouter><LibraryScan/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan library' }))
    expect(await screen.findByRole('button', { name: /Scanning/ })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS) })
    expect(await screen.findByRole('button', { name: 'Scan library' })).toBeEnabled()
  })

  it('checks again as soon as the app comes back into view', async () => {
    api.scanStatus.mockResolvedValueOnce({ scanning: false }).mockResolvedValue({ scanning: false })
    api.startScan.mockResolvedValue({ scanning: true })
    render(<MemoryRouter><LibraryScan/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan library' }))
    expect(await screen.findByRole('button', { name: /Scanning/ })).toBeDisabled()
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByRole('button', { name: 'Scan library' })).toBeEnabled()
  })

  it('shows why Navidrome refused the scan', async () => {
    api.scanStatus.mockResolvedValue({ scanning: false })
    api.startScan.mockRejectedValue(new Error('User not authorized'))
    render(<MemoryRouter><LibraryScan/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan library' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('User not authorized')
  })
})
