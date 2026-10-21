import { describe, expect, it } from 'vitest'
import { bookmarkActionAt, isLongTrack, resumePosition } from './long-tracks'

describe('long tracks', () => {
  it('counts songs of 20 minutes or more', () => {
    expect(isLongTrack(1199)).toBe(false)
    expect(isLongTrack(1200)).toBe(true)
    expect(isLongTrack(undefined)).toBe(false)
  })

  it('resumes only from somewhere in the middle of a long track', () => {
    expect(resumePosition(600, 3600)).toBe(600)
    expect(resumePosition(10, 3600)).toBeNull()
    expect(resumePosition(3570, 3600)).toBeNull()
    expect(resumePosition(600, 300)).toBeNull()
    expect(resumePosition(undefined, 3600)).toBeNull()
  })

  it('saves a place, forgets a finished track and ignores a barely started one', () => {
    expect(bookmarkActionAt(612.7, 3600)).toEqual({ kind: 'save', position: 612 })
    expect(bookmarkActionAt(3550, 3600)).toEqual({ kind: 'clear' })
    expect(bookmarkActionAt(12, 3600)).toBeNull()
    expect(bookmarkActionAt(100, 240)).toBeNull()
  })
})
