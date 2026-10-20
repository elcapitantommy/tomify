import { describe, expect, it } from 'vitest'
import { NavidromeError } from './navidrome'
import { expiresLabel, expiryTime, shareErrorMessage } from './share-links'

describe('share links', () => {
  it('works out expiry times', () => {
    expect(expiryTime('day', 1000)).toBe(1000 + 86_400_000)
    expect(expiryTime('never', 1000)).toBeUndefined()
    expect(expiresLabel(undefined)).toBe('Never expires')
    expect(expiresLabel('0001-01-01T00:00:00Z')).toBe('Never expires')
    expect(expiresLabel('2026-10-01T00:00:00Z', Date.parse('2026-10-20T00:00:00Z'))).toBe('Expired')
    expect(expiresLabel('2026-10-27T12:00:00Z', Date.parse('2026-10-20T00:00:00Z'))).toBe('Expires 27 Oct 2026')
  })

  it('explains that sharing is switched off on the server', () => {
    expect(shareErrorMessage(new NavidromeError('Sharing not enabled', 0))).toMatch(/ND_ENABLESHARING=true/)
    expect(shareErrorMessage(new Error('Tomify cannot reach the music server.'))).toBe('Tomify cannot reach the music server.')
  })
})
