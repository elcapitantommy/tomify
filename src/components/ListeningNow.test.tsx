import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ListeningNow } from './ListeningNow'

const nowPlaying = vi.fn()
vi.mock('../lib/api-context', () => ({ useApi: () => ({ session: { username: 'Tom' }, nowPlaying, coverArtUrl: () => undefined }) }))

describe('ListeningNow', () => {
  it('shows what other accounts are playing, newest per person, and hides your own and stale entries', async () => {
    nowPlaying.mockResolvedValue([
      { id: 's2', title: 'Older', artist: 'X', album: 'Y', username: 'anna', minutesAgo: 3 },
      { id: 's1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', albumId: 'al1', username: 'Anna', minutesAgo: 0 },
      { id: 's3', title: 'Mine', artist: 'X', album: 'Y', username: 'tom', minutesAgo: 0 },
      { id: 's4', title: 'Stopped', artist: 'X', album: 'Y', username: 'sam', minutesAgo: 45 },
    ])
    render(<MemoryRouter><ListeningNow/></MemoryRouter>)
    expect(await screen.findByText('So What')).toBeInTheDocument()
    expect(screen.getByText('Anna')).toBeInTheDocument()
    expect(screen.queryByText('Older')).not.toBeInTheDocument()
    expect(screen.queryByText('Mine')).not.toBeInTheDocument()
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Kind of Blue' })).toHaveAttribute('href', '/albums/al1')
  })

  it('renders nothing when nobody else is listening', async () => {
    nowPlaying.mockResolvedValue([])
    const { container } = render(<MemoryRouter><ListeningNow/></MemoryRouter>)
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
})
