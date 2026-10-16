import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { Settings } from './Settings'

vi.mock('../components/ServerRestart', () => ({ ServerRestart: () => <p>restart control</p> }))
vi.mock('../components/VpnControl', () => ({ VpnControl: () => <p>vpn control</p> }))
vi.mock('../components/LibraryScan', () => ({ LibraryScan: () => <p>scan control</p> }))
vi.mock('../components/ArtworkUpgrade', () => ({ ArtworkUpgrade: () => null }))
vi.mock('../components/QualitySettings', () => ({ QualitySettings: () => <p>quality control</p> }))

const session = { serverUrl: 'https://music.example', username: 'guest', salt: 's', token: 't' }

describe('Settings', () => {
  beforeEach(() => { useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: null }) })

  it('shows administrators the media server controls', () => {
    useAuth.setState({ isAdmin: true })
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText('scan control')).toBeInTheDocument()
    expect(screen.getByText('vpn control')).toBeInTheDocument()
    expect(screen.getByText('restart control')).toBeInTheDocument()
    expect(screen.getByText('quality control')).toBeInTheDocument()
  })

  it('shows other users only that settings are for administrators, and lets them sign out', () => {
    useAuth.setState({ isAdmin: false })
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText(/only available to Navidrome administrators/)).toBeInTheDocument()
    expect(screen.queryByText('vpn control')).not.toBeInTheDocument()
    expect(screen.queryByText('restart control')).not.toBeInTheDocument()
    expect(screen.queryByText('quality control')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('shows nothing admin-only while the role is still being checked', () => {
    render(<MemoryRouter><Settings/></MemoryRouter>)
    expect(screen.getByText('Checking your account…')).toBeInTheDocument()
    expect(screen.queryByText('vpn control')).not.toBeInTheDocument()
  })
})
