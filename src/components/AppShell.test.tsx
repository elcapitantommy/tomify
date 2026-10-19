import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { AppShell } from './AppShell'

vi.mock('./Player', () => ({ PlayerBar: () => null }))
vi.mock('./PlayerRuntime', () => ({ PlayerRuntime: () => null }))
vi.mock('./LivePlaybackSync', () => ({ LivePlaybackSync: () => null }))

const session = { serverUrl: 'https://music.example', username: 'guest', salt: 's', token: 't' }

function renderShell(initialEntries = ['/']) {
  return render(<MemoryRouter initialEntries={initialEntries}><Routes><Route element={<AppShell/>}><Route index element={<p>Home page</p>}/><Route path="albums" element={<p>Albums page</p>}/><Route path="settings" element={<p>Settings page</p>}/><Route path="recovery" element={<p>Recovery page</p>}/></Route></Routes></MemoryRouter>)
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

  it('hides Recovery from non-administrators and keeps Settings and sign out in the account sheet', () => {
    useAuth.setState({ isAdmin: false })
    renderShell()
    expect(within(sidebar()).queryByRole('link', { name: 'Recovery' })).not.toBeInTheDocument()
    expect(within(sidebar()).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    const sheet = screen.getByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByText('guest')).toBeInTheDocument()
    expect(within(sheet).queryByRole('link', { name: 'Recovery' })).not.toBeInTheDocument()
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign out' }))
    expect(useAuth.getState().session).toBeNull()
  })

  it('shows who is signed in at the foot of the sidebar', () => {
    renderShell()
    const footer = sidebar().querySelector('.sidebar-user') as HTMLElement
    expect(within(footer).getByText('guest')).toBeInTheDocument()
    expect(within(footer).getByText('Your Navidrome account')).toBeInTheDocument()
  })

  it('labels an administrator in the sidebar footer', () => {
    useAuth.setState({ isAdmin: true })
    renderShell()
    const footer = sidebar().querySelector('.sidebar-user') as HTMLElement
    expect(within(footer).getByText('Navidrome administrator')).toBeInTheDocument()
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
    // Library health lives inside Settings, and streaming quality is a Settings option.
    expect(within(sheet).queryByRole('link', { name: 'Library health' })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('group', { name: 'Streaming quality' })).not.toBeInTheDocument()
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

  it('returns to the account sheet when Back leaves Settings opened from it', () => {
    useAuth.setState({ isAdmin: true })
    renderShell(['/', '/albums'])
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Account' })).getByRole('link', { name: 'Settings' }))
    expect(screen.getByText('Settings page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(screen.getByText('Albums page')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeInTheDocument()
  })

  it('goes straight back from pages not opened from the account sheet', () => {
    useAuth.setState({ isAdmin: true })
    renderShell(['/', '/albums', '/settings'])
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(screen.getByText('Albums page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
