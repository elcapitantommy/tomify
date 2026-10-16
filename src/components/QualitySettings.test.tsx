import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { QualitySettings } from './QualitySettings'

const targets = [
  { id: 'lossless', label: 'Lossless only', description: 'Lossless: identical to the CD or master' },
  { id: 'transparent-lossy', label: 'Transparent or better', description: 'Transparent: lossy, but sounds the same as lossless' },
  { id: 'lossy', label: 'Any copy', description: 'Any lossy copy with a measured bitrate is good enough' },
]

describe('QualitySettings', () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  beforeEach(() => {
    calls.length = 0
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, isAdmin: true })
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null
      calls.push({ path, method: init.method || 'GET', body })
      if (path === '/api/settings/quality/recheck') return Response.json({ target: 'lossless', checked: 5, changed: 2, recovered: 0, needsUpgrade: 2 })
      return Response.json({ target: body?.target ?? 'transparent-lossy', targets })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows the saved target as one select, saves a change and re-checks labels', async () => {
    render(<QualitySettings/>)
    const select = await screen.findByLabelText(/Preferred quality/) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('transparent-lossy'))
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByText(/Transparent: lossy, but sounds the same as lossless/)).toBeInTheDocument()

    await userEvent.selectOptions(select, 'lossless')
    await waitFor(() => expect(select.value).toBe('lossless'))
    expect(calls).toContainEqual({ path: '/api/settings/quality', method: 'PUT', body: { target: 'lossless' } })

    await userEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(await screen.findByText('Checked 5 items: 2 now need an upgrade.')).toBeInTheDocument()
    expect(calls.at(-1)).toMatchObject({ path: '/api/settings/quality/recheck', method: 'POST' })
  })

  it('explains a refusal instead of showing the controls as ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'forbidden', message: 'Only a Navidrome administrator can change quality settings.' }, { status: 403 })))
    render(<QualitySettings/>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Navidrome administrator')
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeDisabled()
  })
})
