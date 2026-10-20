import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NavidromeError } from '../lib/navidrome'
import { ShareLinkButton, SharedLinks } from './ShareLink'

const api = { createShareLink: vi.fn(), shareLinks: vi.fn(), deleteShareLink: vi.fn(async () => undefined) }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

describe('share links', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('makes a link that expires and copies it', async () => {
    api.createShareLink.mockResolvedValue({ id: 'sh1', url: 'https://music.example/share/sh1', expires: '2030-01-01T00:00:00Z' })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ShareLinkButton ids={['al1']} label="Flood"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Share a link to Flood' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'day' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link' })) })
    expect(api.createShareLink).toHaveBeenCalledWith(['al1'], 'Flood', expect.any(Number))
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveValue('https://music.example/share/sh1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })) })
    expect(writeText).toHaveBeenCalledWith('https://music.example/share/sh1')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says when sharing is switched off on the server', async () => {
    api.createShareLink.mockRejectedValue(new NavidromeError('Sharing not enabled', 0))
    render(<ShareLinkButton ids={['s1']} label="Istanbul" variant="icon"/>)
    fireEvent.click(screen.getByRole('button', { name: 'Share a link to Istanbul' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('ND_ENABLESHARING=true')
  })

  it('lists links in Settings and deletes one', async () => {
    api.shareLinks.mockResolvedValue([{ id: 'sh1', url: 'https://music.example/share/sh1', description: 'Flood', visitCount: 3 }])
    render(<SharedLinks/>)
    expect(await screen.findByText('Flood')).toBeInTheDocument()
    expect(screen.getByText(/opened 3 times/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete link to Flood' })) })
    expect(api.deleteShareLink).toHaveBeenCalledWith('sh1')
  })
})
