import { describe, expect, it } from 'vitest'
import { isTypingTarget, seekTarget, shortcutFor, stepVolume } from './shortcuts'

describe('keyboard shortcuts', () => {
  it('maps keys to player actions', () => {
    expect(shortcutFor({ key: ' ' })).toBe('toggle-play')
    expect(shortcutFor({ key: 'k' })).toBe('toggle-play')
    expect(shortcutFor({ key: 'ArrowRight' })).toBe('seek-forward')
    expect(shortcutFor({ key: 'ArrowRight', shiftKey: true })).toBe('next')
    expect(shortcutFor({ key: 'ArrowLeft', shiftKey: true })).toBe('previous')
    expect(shortcutFor({ key: 'ArrowUp', shiftKey: true })).toBe('volume-up')
    expect(shortcutFor({ key: 'M' })).toBe('mute')
    expect(shortcutFor({ key: '/' })).toBe('search')
    expect(shortcutFor({ key: '?', shiftKey: true })).toBe('help')
  })

  it('leaves browser shortcuts, plain up/down scrolling and other keys alone', () => {
    expect(shortcutFor({ key: 'f', ctrlKey: true })).toBeNull()
    expect(shortcutFor({ key: 'r', metaKey: true })).toBeNull()
    expect(shortcutFor({ key: 'ArrowDown' })).toBeNull()
    expect(shortcutFor({ key: 'x' })).toBeNull()
  })

  it('ignores keys typed into boxes and sliders', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const button = document.createElement('button')
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(textarea)).toBe(true)
    expect(isTypingTarget(button)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('keeps volume and seeking inside the song', () => {
    expect(stepVolume(0.95, 1)).toBe(1)
    expect(stepVolume(0.05, -1)).toBe(0)
    expect(stepVolume(0.5, 1)).toBe(0.6)
    expect(seekTarget(5, 200, -1)).toBe(0)
    expect(seekTarget(195, 200, 1)).toBe(199)
    expect(seekTarget(30, 200, 1)).toBe(40)
  })
})
