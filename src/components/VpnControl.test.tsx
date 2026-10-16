import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { systemApi } from '../lib/recovery-api'
import { VPN_POLL_MS, VpnControl } from './VpnControl'

vi.mock('../lib/recovery-api', () => ({ systemApi: { vpnStatus: vi.fn(), changeVpn: vi.fn() } }))

const connected = { control: 'enabled' as const, state: 'connected' as const, country: 'United Kingdom', city: 'London', server: 'United Kingdom #2214', ip: '194.35.233.10' }
const disconnected = { control: 'enabled' as const, state: 'disconnected' as const }

describe('VpnControl', () => {
  beforeEach(() => { vi.mocked(systemApi.vpnStatus).mockReset(); vi.mocked(systemApi.changeVpn).mockReset() })

  it('shows where the VPN is connected and asks before disconnecting', async () => {
    vi.mocked(systemApi.vpnStatus).mockResolvedValue(connected)
    vi.mocked(systemApi.changeVpn).mockResolvedValue(disconnected)
    render(<VpnControl/>)
    expect(await screen.findByText('VPN connected')).toBeInTheDocument()
    expect(screen.getByText(/London, United Kingdom/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(screen.getByText(/Disconnect now\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(systemApi.changeVpn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect now' }))
    expect(await screen.findByText('VPN disconnected')).toBeInTheDocument()
    expect(systemApi.changeVpn).toHaveBeenCalledWith('disconnect')
  })

  it('connects straight away when disconnected', async () => {
    vi.mocked(systemApi.vpnStatus).mockResolvedValue(disconnected)
    vi.mocked(systemApi.changeVpn).mockResolvedValue(connected)
    render(<VpnControl/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('VPN connected')).toBeInTheDocument()
    expect(systemApi.changeVpn).toHaveBeenCalledWith('connect')
  })

  it('keeps checking while NordVPN is still connecting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(systemApi.vpnStatus).mockResolvedValueOnce(disconnected).mockResolvedValue(connected)
      vi.mocked(systemApi.changeVpn).mockResolvedValue({ control: 'enabled', state: 'connecting' })
      render(<VpnControl/>)
      fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
      expect(await screen.findByText('Connecting…')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(VPN_POLL_MS) })
      expect(await screen.findByText('VPN connected')).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('shows why a change was refused', async () => {
    vi.mocked(systemApi.vpnStatus).mockResolvedValue(disconnected)
    vi.mocked(systemApi.changeVpn).mockRejectedValue(new Error('NordVPN\'s kill switch is not off.'))
    render(<VpnControl/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kill switch')
  })

  it('offers no change when VPN control is turned off on the server', async () => {
    vi.mocked(systemApi.vpnStatus).mockResolvedValue({ control: 'disabled', state: 'unknown' })
    render(<VpnControl/>)
    expect(await screen.findByText(/TOMIFY_RECOVERY_ALLOW_VPN_CONTROL/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Connect|Disconnect/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })
})
