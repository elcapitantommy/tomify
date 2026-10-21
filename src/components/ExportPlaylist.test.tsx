import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportPlaylistButton } from './ExportPlaylist'

describe('Export playlist', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('saves the songs as an .m3u8 file', async () => {
    let saved: Blob | undefined
    Object.assign(URL, { createObjectURL: vi.fn((blob: Blob) => { saved = blob; return 'blob:playlist' }), revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('Road trip.m3u8'); expect(this.href).toBe('blob:playlist') })
    render(<ExportPlaylistButton name="Road trip" tracks={[{ id: 't1', title: 'Istanbul', artist: 'They Might Be Giants', album: 'Flood', duration: 193 }]}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(click).toHaveBeenCalled()
    expect(await saved!.text()).toContain('#EXTINF:193,They Might Be Giants - Istanbul')
  })

  it('is hidden for an empty playlist', () => {
    render(<ExportPlaylistButton name="Empty" tracks={[]}/>)
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })
})
