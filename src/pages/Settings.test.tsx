import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { Settings } from './Settings'

vi.mock('../components/ServerRestart', () => ({ ServerRestart: () => <p>restart control</p> }))
vi.mock('../components/VpnControl', () => ({ VpnControl: () => <p>vpn control</p> }))
vi.mock('../components/LibraryScan', () => ({ LibraryScan: () => <p>scan control</p> }))
vi.mock('../components/ArtworkUpgrade', () => ({ ArtworkUpgrade: () => null }))

const session = { serverUrl: 'https://music.example', username: 'guest', salt: 's', token: 't' }

describe('Settings', () => {
  beforeEach(() => {
    useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: null })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/version') return Response.json({ version: 'abc1234', contract: 2 })
      if (path === '/api/recovery-agent/status') return Response.json({ version: 'abc1234', contract: 2 })
      return new Response('{}', { status: 404 })
    }))
  })

  it('shows administrators the media server controls', () => {
    useAuth.setState({ isAdmin: true })
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText('scan control')).toBeInTheDocument()
    expect(screen.getByText('vpn control')).toBeInTheDocument()
    expect(screen.getByText('restart control')).toBeInTheDocument()
  })

  it('shows other users only that settings are for administrators, and lets them sign out', () => {
    useAuth.setState({ isAdmin: false })
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText(/only available to Navidrome administrators/)).toBeInTheDocument()
    expect(screen.queryByText('vpn control')).not.toBeInTheDocument()
    expect(screen.queryByText('restart control')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('shows nothing admin-only while the role is still being checked', () => {
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText('Checking your account…')).toBeInTheDocument()
    expect(screen.queryByText('vpn control')).not.toBeInTheDocument()
  })

  it('shows app and agent versions and warns when they do not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/version') return Response.json({ version: 'new-site', contract: 2 })
      return Response.json({ version: 'old-agent', contract: 1 })
    }))
    useAuth.setState({ isAdmin: true })
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(await screen.findByText('App new-site')).toBeInTheDocument()
    expect(screen.getByText('Recovery agent old-agent')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/do not match/i)
  })
})
