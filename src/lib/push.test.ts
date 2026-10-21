import { describe, expect, it } from 'vitest'
import { keyBytes, needsHomeScreen } from './push'

describe('push helpers', () => {
  it('only asks iPhones and iPads to use the Home Screen app', () => {
    expect(needsHomeScreen('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', false)).toBe(true)
    expect(needsHomeScreen('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', true)).toBe(false)
    expect(needsHomeScreen('Mozilla/5.0 (Linux; Android 15)', false)).toBe(false)
  })

  it('decodes the server key from base64url', () => {
    expect([...keyBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
  })
})
