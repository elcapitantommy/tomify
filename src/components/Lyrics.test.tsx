import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LyricsPanel } from './Lyrics'
import type { Lyrics } from '../lib/lyrics'

const found: Record<string, Lyrics> = {
  synced: { synced: true, lines: [{ time: 1, text: 'First line' }, { time: 5, text: 'Second line' }, { time: 9, text: 'Third line' }] },
  plain: { synced: false, lines: [{ time: -1, text: 'Just words' }] },
}
const api = { lyrics: async (id: string) => found[id] ?? null }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const track = (id: string) => ({ id, title: 'Song', artist: 'Artist', album: 'Album' })

describe('LyricsPanel', () => {
  it('lights up the line being sung and seeks to a line when it is tapped', async () => {
    const onSeek = vi.fn()
    const song = track('synced')
    const { rerender } = render(<LyricsPanel track={song} time={6} onSeek={onSeek}/>)
    await settle()
    expect(screen.getByText('Second line').closest('li')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('First line').closest('li')).toHaveClass('sung')
    rerender(<LyricsPanel track={song} time={9.9} onSeek={onSeek}/>)
    expect(screen.getByText('Third line').closest('li')).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'First line' }))
    expect(onSeek).toHaveBeenCalledWith(1)
  })

  it('shows plain lyrics as text and says when there are none', async () => {
    const { rerender } = render(<LyricsPanel track={track('plain')} time={0}/>)
    await settle()
    expect(screen.getByText('Just words')).toBeInTheDocument()
    expect(screen.getByText('These lyrics are not synced to the song.')).toBeInTheDocument()
    // Navidrome has none, and neither does LRCLIB through the Worker.
    vi.stubGlobal('fetch', async () => Response.json({ synced: null, plain: null }))
    rerender(<LyricsPanel track={track('none')} time={0}/>)
    await settle()
    expect(screen.getByText('No lyrics found for this song.')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
