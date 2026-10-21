import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Notifications } from './Notifications'

const push = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true), needsHomeScreen: vi.fn(() => false), currentSubscription: vi.fn(), subscribe: vi.fn(),
  pushApi: { state: vi.fn(), save: vi.fn(), test: vi.fn() },
}))
vi.mock('../lib/push', () => push)

const subscription = { endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn(async () => true) }

describe('Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    push.pushSupported.mockReturnValue(true)
    push.needsHomeScreen.mockReturnValue(false)
    push.currentSubscription.mockResolvedValue(null)
    push.pushApi.state.mockResolvedValue({ publicKey: 'BKEY', topics: null })
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') })
  })

  it('asks permission, subscribes and saves the chosen topic', async () => {
    push.subscribe.mockResolvedValue(subscription)
    push.pushApi.save.mockResolvedValue({ topics: ['new-releases'] })
    render(<Notifications admin={false}/>)
    expect(screen.queryByRole('switch', { name: 'Recovery downloads notifications' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('switch', { name: 'New releases notifications' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'New releases notifications' })).toBeChecked())
    expect(push.subscribe).toHaveBeenCalledWith('BKEY')
    expect(push.pushApi.save).toHaveBeenCalledWith(subscription.toJSON(), ['new-releases'])
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeInTheDocument()
  })

  it('shows what this device is already subscribed to, and turning the last one off unsubscribes', async () => {
    push.currentSubscription.mockResolvedValue(subscription)
    push.pushApi.state.mockResolvedValue({ publicKey: 'BKEY', topics: ['recovery'] })
    push.pushApi.save.mockResolvedValue({ topics: [] })
    render(<Notifications admin/>)
    const recovery = await screen.findByRole('switch', { name: 'Recovery downloads notifications' })
    await waitFor(() => expect(recovery).toBeChecked())
    expect(push.pushApi.state).toHaveBeenCalledWith('https://push.example/1')
    fireEvent.click(recovery)
    await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalled())
    expect(push.pushApi.save).toHaveBeenCalledWith(subscription.toJSON(), [])
  })

  it('says when notifications are blocked', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn(async () => 'denied') })
    render(<Notifications admin={false}/>)
    fireEvent.click(await screen.findByRole('switch', { name: 'New releases notifications' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Notifications are blocked')
    expect(push.subscribe).not.toHaveBeenCalled()
  })

  it('tells iPhone users to add Tomify to the Home Screen first', () => {
    push.pushSupported.mockReturnValue(false)
    push.needsHomeScreen.mockReturnValue(true)
    render(<Notifications admin={false}/>)
    expect(screen.getByText(/add Tomify to your Home Screen first/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('sends a test notification', async () => {
    push.currentSubscription.mockResolvedValue(subscription)
    push.pushApi.state.mockResolvedValue({ publicKey: 'BKEY', topics: ['new-releases'] })
    push.pushApi.test.mockResolvedValue({ sent: 1 })
    render(<Notifications admin={false}/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Test sent')
  })
})
