import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { AppShell } from './AppShell'

vi.mock('./Player', () => ({ PlayerBar: () => null }))
vi.mock('./PlayerRuntime', () => ({ PlayerRuntime: () => null }))
vi.mock('./LivePlaybackSync', () => ({ LivePlaybackSync: () => null }))

const session = { serverUrl: 'https://music.example', username: 'guest', salt: 's', token: 't' }

function renderShell() {
  return render(<MemoryRouter><Routes><Route element={<AppShell/>}><Route index element={<p>Home page</p>}/></Route></Routes></MemoryRouter>)
}
const mobileNav = () => document.querySelector('.mobile-nav') as HTMLElement
const sidebar = () => document.querySelector('.sidebar') as HTMLElement

describe('AppShell navigation', () => {
  beforeEach(() => { useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: null }) })

  it('gives everyone Playlists in the mobile tab bar instead of Recovery', () => {
    useAuth.setState({ isAdmin: true })
    renderShell()
    expect(within(mobileNav()).getByRole('link', { name: 'Playlists' })).toHaveAttribute('href', '/playlists')
    expect(within(mobileNav()).queryByRole('link', { name: 'Recovery' })).not.toBeInTheDocument()
  })

  it('hides Recovery and Settings from non-administrators and keeps sign out in the account sheet', () => {
    useAuth.setState({ isAdmin: false })
    renderShell()
    expect(within(sidebar()).queryByRole('link', { name: 'Recovery' })).not.toBeInTheDocument()
    expect(within(sidebar()).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    const sheet = screen.getByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByText('guest')).toBeInTheDocument()
    expect(within(sheet).queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign out' }))
    expect(useAuth.getState().session).toBeNull()
  })

  it('treats an unfinished role check as not an administrator', () => {
    renderShell()
    expect(within(sidebar()).queryByRole('link', { name: 'Recovery' })).not.toBeInTheDocument()
  })

  it('shows administrators Recovery in the sidebar and Recovery and Settings in the account sheet', () => {
    useAuth.setState({ isAdmin: true })
    renderShell()
    expect(within(sidebar()).getByRole('link', { name: 'Recovery' })).toHaveAttribute('href', '/recovery')
    expect(within(sidebar()).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    const sheet = screen.getByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByRole('link', { name: 'Recovery' })).toHaveAttribute('href', '/recovery')
    expect(within(sheet).getByRole('link', { name: 'Library health' })).toHaveAttribute('href', '/library-health')
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the account sheet when the backdrop is tapped', () => {
    useAuth.setState({ isAdmin: true })
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(document.querySelector('.account-sheet-backdrop') as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
