import { describe, expect, it } from 'vitest'
import { nextRating, ratingOf } from './ratings'

describe('ratings', () => {
  it('prefers a rating set this session over the one the server sent', () => {
    expect(ratingOf({}, { id: 's1', userRating: 3 })).toBe(3)
    expect(ratingOf({ s1: 5 }, { id: 's1', userRating: 3 })).toBe(5)
    expect(ratingOf({ s1: 0 }, { id: 's1', userRating: 3 })).toBe(0)
    expect(ratingOf({}, { id: 's2' })).toBe(0)
  })

  it('clears the rating when the same star is picked again', () => {
    expect(nextRating(0, 4)).toBe(4)
    expect(nextRating(4, 2)).toBe(2)
    expect(nextRating(4, 4)).toBe(0)
  })
})
