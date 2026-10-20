import { describe, expect, it } from 'vitest'
import { dropIndex, insertionPoint, moveItem } from './reorder'

describe('reordering', () => {
  it('finds where a dragged row lands', () => {
    const mids = [10, 30, 50, 70]
    expect(insertionPoint(mids, 0)).toBe(0)
    expect(insertionPoint(mids, 35)).toBe(2)
    expect(insertionPoint(mids, 99)).toBe(4)
    expect(dropIndex(0, 2)).toBe(1)
    expect(dropIndex(3, 1)).toBe(1)
    expect(dropIndex(1, 1)).toBe(1)
    expect(dropIndex(1, 2)).toBe(1)
  })

  it('moves one item and leaves the rest in order', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    const same = ['a', 'b']
    expect(moveItem(same, 1, 1)).toBe(same)
  })
})
