import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRatings } from '../stores/ratings'
import { RatingStars } from './RatingStars'

const api = { setRating: vi.fn() }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))

describe('RatingStars', () => {
  beforeEach(() => { api.setRating.mockReset(); useRatings.setState({ overrides: {} }) })

  it('shows the rating Navidrome sent and saves a new one', async () => {
    api.setRating.mockResolvedValue(undefined)
    render(<RatingStars item={{ id: 'al1', userRating: 2 }} name="Flood"/>)
    expect(screen.getByRole('group', { name: 'Rating for Flood: 2 of 5 stars' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rate Flood 5 stars' })) })
    expect(api.setRating).toHaveBeenCalledWith('al1', 5)
    expect(screen.getByRole('group', { name: 'Rating for Flood: 5 of 5 stars' })).toBeInTheDocument()
  })

  it('puts the old rating back when the music server refuses', async () => {
    api.setRating.mockRejectedValue(new Error('nope'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<RatingStars item={{ id: 's1' }} name="Istanbul"/>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rate Istanbul 1 star' })) })
    expect(screen.getByRole('group', { name: 'Rating for Istanbul: not rated' })).toBeInTheDocument()
  })
})
