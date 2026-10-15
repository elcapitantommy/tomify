import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { systemApi } from '../lib/recovery-api'
import { ServerRestart } from './ServerRestart'

vi.mock('../lib/recovery-api', () => ({ systemApi: { restartServer: vi.fn() } }))

describe('ServerRestart', () => {
  beforeEach(() => { vi.mocked(systemApi.restartServer).mockReset() })

  it('asks for confirmation before restarting and can be cancelled', () => {
    render(<ServerRestart/>)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(screen.getByText(/Restart now\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    expect(systemApi.restartServer).not.toHaveBeenCalled()
  })

  it('restarts the server once confirmed', async () => {
    vi.mocked(systemApi.restartServer).mockResolvedValue({ rebooting: true, scheduledAt: '2026-10-15T12:00:03.000Z' })
    render(<ServerRestart/>)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(await screen.findByText(/Restart requested/)).toBeInTheDocument()
    expect(systemApi.restartServer).toHaveBeenCalledTimes(1)
  })

  it('shows why a restart was refused', async () => {
    vi.mocked(systemApi.restartServer).mockRejectedValue(new Error('Only a Navidrome administrator can restart the media server.'))
    render(<ServerRestart/>)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Navidrome administrator')
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
  })
})
