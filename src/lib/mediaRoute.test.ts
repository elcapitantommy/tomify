import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLanUrl, lanOriginFrom, mediaRoute, mediaStreamFailed, probeLan, startMediaRoute } from './mediaRoute'
import { DEFAULT_NAVIDROME_SERVER, NavidromeClient } from './navidrome'

const login = { serverUrl: DEFAULT_NAVIDROME_SERVER, username: 'tom', token: 'a'.repeat(32), salt: 'salt1' }
const LAN = 'https://lan.tomify.example:8789'

function fakeServer({ session = 200, lanOrigin = LAN as string | null, lanUp = true } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/media-session') {
      if (session !== 200) return Response.json({ error: 'not-configured' }, { status: session })
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('x-tomify-token')).toBe(login.token)
      return Response.json({ token: 'iv.sealed+/=', expiresAt: Date.now() + 4 * 3600_000, lanOrigin })
    }
    if (url === `${LAN}/lan/ping`) { if (!lanUp) throw new TypeError('Failed to fetch'); return Response.json({ ok: true }) }
    throw new Error(`unexpected ${url}`)
  })
}

describe('media sessions and LAN-direct streaming', () => {
  let stop: (() => void) | undefined
  afterEach(() => { stop?.(); stop = undefined })

  it('accepts only an https origin for the box', () => {
    expect(lanOriginFrom('https://lan.example:8789')).toBe('https://lan.example:8789')
    expect(lanOriginFrom('https://lan.example/')).toBe('https://lan.example')
    for (const bad of ['http://192.168.1.5:8789', 'https://lan.example/music', 'https://u:p@lan.example', 'nope', null, 7]) expect(lanOriginFrom(bad)).toBeNull()
  })

  it('probes the box with a short timeout and treats any failure as not at home', async () => {
    expect(await probeLan(LAN, vi.fn(async () => Response.json({ ok: true })))).toBe(true)
    expect(await probeLan(LAN, vi.fn(async () => new Response(null, { status: 502 })))).toBe(false)
    expect(await probeLan(LAN, vi.fn(async () => { throw new TypeError('blocked') }))).toBe(false)
    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const started = Date.now()
    expect(await probeLan(LAN, hanging, 20)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('streams from the box with a media token when it answers on the home network', async () => {
    stop = startMediaRoute(login, fakeServer())
    await vi.waitFor(() => expect(mediaRoute('tom')?.origin).toBe(LAN))
    expect(mediaRoute('tom')?.token).toBe('iv.sealed+/=')
    expect(mediaRoute('someone-else')).toBeNull()
    expect(isLanUrl(`${LAN}/navidrome/rest/stream.view`)).toBe(true)
    expect(isLanUrl('https://app.example/navidrome/rest/stream.view')).toBe(false)

    const api = new NavidromeClient(login)
    const stream = new URL(api.streamUrl('tr1'))
    expect(stream.origin + stream.pathname).toBe(`${LAN}/navidrome/rest/stream.view`)
    expect(Object.fromEntries(stream.searchParams)).toEqual({ id: 'tr1', estimateContentLength: 'true', v: '1.16.1', c: 'Tomify', mt: 'iv.sealed+/=' })
    const hls = new URL(api.hlsUrl('tr1', 'album')!)
    expect(hls.origin + hls.pathname).toBe(`${LAN}/api/hls/tr1/album/master.m3u8`)
    expect(Object.fromEntries(hls.searchParams)).toEqual({ mt: 'iv.sealed+/=' })

    // Left home: the next load goes through the Worker, still with the token.
    expect(mediaStreamFailed(stream.toString())).toBe(true)
    expect(mediaStreamFailed('https://app.example/navidrome/rest/stream.view?id=tr1')).toBe(false)
    const viaWorker = new URL(api.streamUrl('tr1'))
    expect(viaWorker.origin).toBe(window.location.origin)
    expect(viaWorker.searchParams.get('mt')).toBe('iv.sealed+/=')
    expect(viaWorker.searchParams.get('t')).toBeNull()
  })

  it('streams through the Worker with a token when the box does not answer', async () => {
    const fetcher = fakeServer({ lanUp: false })
    stop = startMediaRoute(login, fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(mediaRoute('tom')).toEqual({ token: 'iv.sealed+/=', origin: null })
    expect(new URL(new NavidromeClient(login).hlsUrl('tr1')!).origin).toBe(window.location.origin)
  })

  it('keeps the old URLs when the Worker has no media sessions, and for other music servers', async () => {
    const fetcher = fakeServer({ session: 404 })
    stop = startMediaRoute(login, fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(mediaRoute('tom')).toBeNull()
    expect(new URL(new NavidromeClient(login).hlsUrl('tr1')!).searchParams.get('t')).toBe(login.token)
    expect(new URL(new NavidromeClient(login).streamUrl('tr1')).searchParams.get('u')).toBe('tom')

    const other = new NavidromeClient({ ...login, serverUrl: 'https://music.example' }, fetcher)
    expect(other.startMediaSessions).toBeTypeOf('function')
    other.startMediaSessions()()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('asks for a new token when a token stream fails, and drops tokens the Worker stopped handing out', async () => {
    let session = 200
    const working = fakeServer({ lanOrigin: null })
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => session === 200 ? working(input, init) : Response.json({ error: 'not-configured' }, { status: session }))
    stop = startMediaRoute(login, fetcher)
    await vi.waitFor(() => expect(mediaRoute('tom')).not.toBeNull())
    const url = new NavidromeClient(login).streamUrl('tr1')
    mediaStreamFailed(url)
    expect(fetcher).toHaveBeenCalledTimes(1) // not again within a minute
    session = 404
    const later = Date.now() + 2 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(mediaStreamFailed(url)).toBe(false)
    await vi.waitFor(() => expect(mediaRoute('tom', later)).toBeNull())
    expect(new URL(new NavidromeClient(login).streamUrl('tr1')).searchParams.get('t')).toBe(login.token)
    vi.restoreAllMocks()
  })

  it('forgets the session when it stops', async () => {
    stop = startMediaRoute(login, fakeServer({ lanOrigin: null }))
    await vi.waitFor(() => expect(mediaRoute('tom')).toEqual({ token: 'iv.sealed+/=', origin: null }))
    stop()
    stop = undefined
    expect(mediaRoute('tom')).toBeNull()
  })
})
