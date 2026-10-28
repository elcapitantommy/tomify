import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaToken, mediaTokenStatus, setMediaGrant, startMediaTokens, MIN_TOKEN_LIFE_MS } from './mediaToken'

const login = { username: 'tom', token: '0123456789abcdef0123456789abcdef', salt: 'abc123' }

afterEach(() => { setMediaGrant(null); vi.useRealTimers() })

describe('TomTube media token', () => {
  it('fetches a token with the login in headers only, and renews it at half its life', async () => {
    vi.useFakeTimers()
    let issued = 0
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ token: `tok-${++issued}`, expiresAt: Date.now() + 4 * 3600_000 }))
    const stop = startMediaTokens(login, fetcher as never)
    await vi.waitFor(() => expect(mediaToken('tom')).toBe('tok-1'))
    expect(mediaTokenStatus()).toBe('ready')
    expect(String(fetcher.mock.calls[0][0])).toBe('/api/media-session')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-tomify-salt')).toBe('abc123')
    expect(mediaToken('someone-else')).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * 3600_000)
    expect(mediaToken('tom')).toBe('tok-2')
    stop()
  })

  it('keeps a valid token through a failed renewal, and drops one about to expire', async () => {
    setMediaGrant({ username: 'tom', token: 'tok-1', expiresAt: Date.now() + 3600_000 })
    const stop = startMediaTokens(login, vi.fn(async () => { throw new TypeError('offline') }) as never)
    await vi.waitFor(() => expect(mediaTokenStatus()).toBe('ready'))
    expect(mediaToken('tom')).toBe('tok-1')
    expect(mediaToken('tom', Date.now() + 3600_000 - MIN_TOKEN_LIFE_MS + 1)).toBeNull()
    stop()
  })
})
