import { describe, expect, it, vi } from 'vitest'
import { NavidromeClient, NavidromeError, createAuthSession, normaliseServerUrl } from './navidrome'

describe('NavidromeClient', () => {
  const session = { serverUrl: 'https://music.example', username: 'tom', salt: 'salt', token: 'token' }
  it('centralises authenticated request parameters', () => { const url = new NavidromeClient(session).url('ping'); expect(url.pathname).toBe('/rest/ping.view'); expect(url.searchParams.get('u')).toBe('tom'); expect(url.searchParams.get('p')).toBeNull(); expect(url.searchParams.get('c')).toBe('Tomify') })
  it('normalises servers and never stores the password', () => { const auth = createAuthSession('https://music.example///', ' tom ', 'secret'); expect(auth.serverUrl).toBe(normaliseServerUrl('https://music.example/')); expect(auth.username).toBe('tom'); expect(auth.salt).toMatch(/^[a-f0-9]{12}$/); expect(JSON.stringify(auth)).not.toContain('secret') })
  it('returns typed albums from the Subsonic envelope', async () => { const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', albumList2: { album: [{ id: '1', name: 'Blue', artist: 'Joni' }] } } }), { status: 200 })); const albums = await new NavidromeClient(session, fetcher).albums(); expect(albums[0].name).toBe('Blue') })
  it('turns API failures into useful errors', async () => { const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username' } } }), { status: 200 })); await expect(new NavidromeClient(session, fetcher).ping()).rejects.toEqual(expect.objectContaining<Partial<NavidromeError>>({ message: 'Wrong username', code: 40 })) })
})
