import { describe, expect, it } from 'vitest'
import { selectedItems, toggleSelection } from './selection'

describe('selecting songs', () => {
  it('ticks and unticks one song at a time', () => {
    const once = toggleSelection(new Set(), 2, null, false)
    expect([...once]).toEqual([2])
    expect([...toggleSelection(once, 2, 2, false)]).toEqual([])
  })

  it('shift-ticks the run between the last song and this one, either way round', () => {
    expect([...toggleSelection(new Set([1]), 4, 1, true)].sort()).toEqual([1, 2, 3, 4])
    expect([...toggleSelection(new Set([5]), 2, 5, true)].sort()).toEqual([2, 3, 4, 5])
  })

  it('unticks a run when the last song was unticked', () => {
    expect([...toggleSelection(new Set([0, 2, 3]), 3, 1, true)]).toEqual([0])
  })

  it('returns ticked items in list order', () => {
    expect(selectedItems(['a', 'b', 'c', 'd'], new Set([3, 0]))).toEqual(['a', 'd'])
  })
})
