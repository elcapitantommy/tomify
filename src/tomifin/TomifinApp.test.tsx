import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TomifinApp } from './TomifinApp'
import { formatEta, formatSize } from './api'
import { sortResults } from './results'
import type { TomifinJob, TomifinResult } from './api'

const quality = { resolution: '1080p', hdr: null, codec: 'H.264', source: 'BluRay' }
const results: TomifinResult[] = [
  { id: 'a'.repeat(64), title: 'Big Buck Bunny (2008) 1080p BluRay x264', source: 'yts.test', size: 1_500_000_000, seeders: 40, leechers: 3, type: 'torrent', linkType: 'magnet', detailsUrl: 'https://yts.test/bbb', quality },
  { id: 'b'.repeat(64), title: 'Big Buck Bunny 2160p WEB-DL HDR', source: 'Example', size: 9_000_000_000, seeders: 12, leechers: 8, type: 'torrent', linkType: 'torrent-file', detailsUrl: null, quality: { resolution: '2160p', hdr: 'HDR', codec: null, source: 'WEB-DL' } },
]
const job = (extra: Partial<TomifinJob> = {}): TomifinJob => ({
  id: '00000000-0000-4000-8000-000000000001', name: 'Big Buck Bunny (2008)', destination: 'family', destinationLabel: 'Family', status: 'downloading', message: null,
  progress: 42.3, downloadSpeed: 2_500_000, uploadSpeed: 0, downloaded: 635_000_000, size: 1_500_000_000, eta: 345, seeds: 10, peers: 2, source: 'yts.test',
  createdAt: '2026-10-23T10:00:00Z', canPause: true, canResume: false, keepsFilesOnCancel: false, ...extra,
})

const usenetResult: TomifinResult = { id: 'c'.repeat(64), title: 'Big Buck Bunny 2008 1080p WEB-DL', source: 'NZBgeek', size: 2_000_000_000, seeders: null, leechers: null, grabs: 120, ageDays: 400, type: 'usenet', linkType: 'nzb', detailsUrl: null, quality }
const linked = (body: unknown) => {
  const input = body as { link?: string; file?: { name: string } }
  const nzb = Boolean(input.file?.name.endsWith('.nzb') || input.link?.endsWith('.nzb'))
  return { detected: nzb ? 'nzb' : 'magnet', result: nzb ? { ...usenetResult, id: 'd'.repeat(64), title: 'Sintel 2010', origin: 'link' } : { ...results[0], id: 'e'.repeat(64), title: 'Sintel 2010', source: 'Pasted link', origin: 'link' } }
}

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }
// Every request the page makes is answered here: nothing reaches Tomify, Jellyfin, the media server or qBittorrent.
function fakeApi({ vpn = { state: 'connected', qbittorrent: 'connected', nordvpn: { state: 'connected', country: 'United Kingdom', city: 'London', server: 'uk2012.nordvpn.com' } } as unknown, signedIn = true, jobs = [] as TomifinJob[], download = (body: { destination: string }) => new Response(JSON.stringify({ job: job({ destination: body.destination as TomifinJob['destination'], destinationLabel: body.destination === 'private' ? 'Private' : 'Family', status: 'queued', progress: 0 }) }), { status: 202 }), status = { available: true, problem: null, destinations: [{ id: 'family', label: 'Family', available: true }, { id: 'private', label: 'Private', available: true }] } as unknown, searchResults = results as TomifinResult[], searchExtra = {} as Record<string, unknown>, link = (body: unknown) => Response.json(linked(body)) as Response } = {}) {
  let session = signedIn
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers as Record<string, string> })
    if (url === '/api/tomifin/session') {
      if (init.method === 'POST') {
        if (body.password !== 'right') return Response.json({ error: 'invalid-login', message: 'Jellyfin did not accept that username and password.' }, { status: 401 })
        session = true
        return Response.json({ user: { name: body.username } })
      }
      if (init.method === 'DELETE') { session = false; return Response.json({ signedOut: true }) }
      return session ? Response.json({ user: { name: 'tom' } }) : Response.json({ error: 'unauthorized', message: 'Sign in with your Jellyfin account.' }, { status: 401 })
    }
    if (!session) return Response.json({ error: 'unauthorized', message: 'Your Jellyfin session has ended. Sign in again.' }, { status: 401 })
    if (url === '/api/tomifin/status') return Response.json(status)
    if (url === '/api/tomifin/vpn') return vpn instanceof Response ? vpn : Response.json(vpn)
    if (url.startsWith('/api/tomifin/search')) return Response.json({ query: new URL(url, 'https://x').searchParams.get('q'), kind: 'video', results: searchResults, ...searchExtra })
    if (url === '/api/tomifin/link') return link(body)
    if (url === '/api/tomifin/download') return download(body)
    if (url === '/api/tomifin/downloads') return Response.json({ jobs })
    if (/\/api\/tomifin\/downloads\/.+\/(pause|resume|cancel)$/.test(url)) return Response.json(url.endsWith('cancel') ? { cancelled: true, filesDeleted: true } : { job: job() })
    return Response.json({ error: 'not-found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

async function open() {
  render(<TomifinApp/>)
  await screen.findByText(/Signed in as/)
}

async function search(text = 'Big Buck Bunny') {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search for media' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  return screen.findByText('Big Buck Bunny (2008) 1080p BluRay x264')
}

describe('Tomifin Downloader', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('loads on its own and asks for a Jellyfin sign-in when signed out', async () => {
    const calls = fakeApi({ signedIn: false })
    render(<TomifinApp/>)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TOMIFIN DOWNLOADER')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Jellyfin username')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(calls.map((call) => call.url)).toEqual(['/api/tomifin/session'])
  })

  it('signs in with Jellyfin, shows a refused sign-in, and signs out', async () => {
    const calls = fakeApi({ signedIn: false })
    render(<TomifinApp/>)
    fireEvent.change(await screen.findByLabelText('Jellyfin username'), { target: { value: 'tom' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Jellyfin did not accept that username and password.')
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Signed in as/)).toHaveTextContent('Signed in as tom')
    const signIn = calls.filter((call) => call.method === 'POST' && call.url === '/api/tomifin/session').at(-1)!
    expect(signIn.body).toEqual({ username: 'tom', password: 'right' })
    expect(signIn.headers).toMatchObject({ 'x-tomifin': '1' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/tomifin/session')).toBe(true))
  })

  it('goes back to the sign-in form when the Jellyfin session ends', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/tomifin/session'
      ? Response.json({ user: { name: 'tom' } })
      : Response.json({ error: 'unauthorized', message: 'Your Jellyfin session has ended. Sign in again.' }, { status: 401 })))
    render(<TomifinApp/>)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('searches Tomify’s sources and shows torrents with their source, size, seeders and quality', async () => {
    const calls = fakeApi()
    await open()
    await search()
    const searchCall = calls.find((call) => call.url.startsWith('/api/tomifin/search'))!
    expect(searchCall.url).toBe('/api/tomifin/search?q=Big+Buck+Bunny&kind=video')
    expect(JSON.stringify(searchCall.headers)).not.toMatch(/token|password/i)
    const card = screen.getByText('Big Buck Bunny (2008) 1080p BluRay x264').closest('li')!
    expect(within(card).getByText('yts.test')).toBeInTheDocument()
    expect(within(card).getByText('1.40 GB')).toBeInTheDocument()
    expect(within(card).getByText('40')).toBeInTheDocument()
    expect(within(card).getByText('Torrent · Magnet')).toBeInTheDocument()
    expect(within(card).getByText('1080p')).toBeInTheDocument()
    expect(screen.getByText('Torrent · File')).toBeInTheDocument()
    expect(screen.getByText('2 of 2 results for “Big Buck Bunny”')).toBeInTheDocument()
  })

  it('filters by quality and sorts by size', async () => {
    fakeApi()
    await open()
    await search()
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: '2160p' } })
    expect(screen.queryByText('Big Buck Bunny (2008) 1080p BluRay x264')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'any' } })
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'size-desc' } })
    const titles = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(titles.slice(0, 2)).toEqual(['Big Buck Bunny 2160p WEB-DL HDR', 'Big Buck Bunny (2008) 1080p BluRay x264'])
  })

  it('will not queue until Family or Private is chosen, and never picks one itself', async () => {
    const calls = fakeApi()
    await open()
    expect(screen.getByText('No destination selected yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /FAMILY/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /PRIVATE/ })).toHaveAttribute('aria-pressed', 'false')
    const card = (await search()).closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: 'Queue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose Family or Private before queuing a download.')
    expect(calls.some((call) => call.url === '/api/tomifin/download')).toBe(false)
  })

  it.each([['family', 'FAMILY', 'Family', '/media/family'], ['private', 'PRIVATE', 'Private', '/media/private']])('queues a %s download only after qBittorrent accepts it', async (destination, button, label, path) => {
    let accept: (response: Response) => void = () => {}
    const calls = fakeApi({ download: () => new Promise((resolve) => { accept = resolve }) as unknown as Response })
    await open()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(button) }))
    expect(screen.getByRole('button', { name: new RegExp(button) })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Downloads will be saved to/)).toHaveTextContent(`Downloads will be saved to ${label} (${path}).`)
    const card = (await search()).closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: `Queue to ${label}` }))
    expect(await within(card).findByRole('button', { name: 'Queuing…' })).toBeDisabled()
    expect(screen.queryByText(/Queued in qBittorrent/)).not.toBeInTheDocument()
    expect(calls.find((call) => call.url === '/api/tomifin/download')!.body).toEqual({ resultId: 'a'.repeat(64), destination })
    await act(async () => { accept(new Response(JSON.stringify({ job: job({ destination: destination as TomifinJob['destination'] }) }), { status: 202 })) })
    expect(await screen.findByRole('status')).toHaveTextContent(`Queued in qBittorrent: “Big Buck Bunny (2008) 1080p BluRay x264” → ${label} (${path}).`)
    expect(within(card).getByRole('button', { name: 'Queued' })).toBeDisabled()
  })

  it('shows why a download could not be queued', async () => {
    fakeApi({ download: () => Response.json({ error: 'duplicate', message: 'This torrent is already in qBittorrent.' }, { status: 409 }) })
    await open()
    fireEvent.click(screen.getByRole('button', { name: /PRIVATE/ }))
    const card = (await search()).closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: 'Queue to Private' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not queue “Big Buck Bunny (2008) 1080p BluRay x264”: This torrent is already in qBittorrent.')
    expect(within(card).getByRole('button', { name: 'Queue to Private' })).toBeEnabled()
  })

  it('shows a search error and an unavailable server clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/tomifin/session' ? Response.json({ user: { name: 'tom' } }) : url === '/api/tomifin/status'
      ? Response.json({ available: false, problem: 'Set TOMIFY_TOMIFIN_FAMILY_DIR and TOMIFY_TOMIFIN_PRIVATE_DIR to turn Tomifin Downloader on.', destinations: [{ id: 'family', label: 'Family', available: false }, { id: 'private', label: 'Private', available: false }] })
      : Response.json({ error: 'agent-error', message: 'qBittorrent is offline, so torrent search is paused.' }, { status: 502 })))
    await open()
    expect(await screen.findByText(/Tomifin Downloader is not available: Set TOMIFY_TOMIFIN_FAMILY_DIR/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /FAMILY/ })).toBeDisabled()
  })

  it('lists downloads with progress, speed, size and time left, and pauses and cancels them', async () => {
    const calls = fakeApi({ jobs: [job(), job({ id: '00000000-0000-4000-8000-000000000002', name: 'Sintel', destination: 'private', destinationLabel: 'Private', status: 'completed', progress: 100, canPause: false, keepsFilesOnCancel: true })] })
    await open()
    const active = (await screen.findByText('Big Buck Bunny (2008)')).closest('li')!
    expect(within(active).getByText('Downloading')).toBeInTheDocument()
    expect(within(active).getByText('42.3%')).toBeInTheDocument()
    expect(within(active).getByText('606 MB of 1.40 GB')).toBeInTheDocument()
    expect(within(active).getByText('2.38 MB/s')).toBeInTheDocument()
    expect(within(active).getByText('6 min')).toBeInTheDocument()
    expect(within(active).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42.3')
    const done = screen.getByText('Sintel').closest('li')!
    expect(within(done).getByText('Completed')).toBeInTheDocument()
    expect(within(done).getByText('Private')).toBeInTheDocument()

    fireEvent.click(within(active).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(calls.some((call) => call.url === `/api/tomifin/downloads/${job().id}/pause` && call.method === 'POST')).toBe(true))

    fireEvent.click(within(active).getByRole('button', { name: 'Cancel' }))
    expect(within(active).getByText('Cancel and delete the partial download?')).toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/cancel'))).toBe(false)
    fireEvent.click(within(active).getByRole('button', { name: 'Yes, cancel' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Cancelled “Big Buck Bunny (2008)” and deleted its partial download.')

    fireEvent.click(within(done).getByRole('button', { name: 'Remove' }))
    expect(within(done).getByText('Remove from this list? The files stay in the library.')).toBeInTheDocument()
  })

  it('shows Usenet results beside torrents, labelled, without seeders', async () => {
    fakeApi({ searchResults: [...results, usenetResult], searchExtra: { usenet: true, warnings: ['One Usenet indexer did not answer.'] } })
    await open()
    await search()
    const card = screen.getByText('Big Buck Bunny 2008 1080p WEB-DL').closest('li')!
    expect(within(card).getByText('Usenet · NZB')).toBeInTheDocument()
    expect(within(card).getByText('NZBgeek')).toBeInTheDocument()
    expect(within(card).getByText('120')).toBeInTheDocument()
    expect(within(card).queryByText(/Seeders/)).not.toBeInTheDocument()
    expect(screen.getByText(/One Usenet indexer did not answer/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'usenet' } })
    expect(screen.queryByText('Big Buck Bunny (2008) 1080p BluRay x264')).not.toBeInTheDocument()
    expect(screen.getByText('Big Buck Bunny 2008 1080p WEB-DL')).toBeInTheDocument()
  })

  it('queues a Usenet result in SABnzbd with only its result id and destination', async () => {
    const calls = fakeApi({ searchResults: [usenetResult], searchExtra: { usenet: true } })
    await open()
    fireEvent.click(screen.getByRole('button', { name: /FAMILY/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search for media' }), { target: { value: 'Big Buck Bunny' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const card = (await screen.findByText('Big Buck Bunny 2008 1080p WEB-DL')).closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: 'Queue to Family' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Queued in SABnzbd: “Big Buck Bunny 2008 1080p WEB-DL” → Family (/media/family).')
    expect(calls.find((call) => call.url === '/api/tomifin/download')!.body).toEqual({ resultId: 'c'.repeat(64), destination: 'family' })
  })

  it('checks a pasted magnet link, shows what it is, and adds it to the chosen library', async () => {
    const calls = fakeApi()
    await open()
    const field = screen.getByRole('textbox', { name: 'Magnet, .torrent or .nzb link' })
    fireEvent.change(field, { target: { value: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Sintel' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose Family or Private before queuing a download.')
    expect(calls.some((call) => call.url === '/api/tomifin/link')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByText('Torrent · Magnet link')).toBeInTheDocument()
    expect(calls.find((call) => call.url === '/api/tomifin/link')!.body).toEqual({ link: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Sintel' })
    expect(calls.find((call) => call.url === '/api/tomifin/link')!.headers).toMatchObject({ 'x-tomifin': '1' })
    fireEvent.click(screen.getByRole('button', { name: /PRIVATE/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Private' }))
    await waitFor(() => expect(calls.find((call) => call.url === '/api/tomifin/download')?.body).toEqual({ resultId: 'e'.repeat(64), destination: 'private' }))
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('uploads an .nzb file and detects it as Usenet', async () => {
    const calls = fakeApi()
    await open()
    fireEvent.click(screen.getByRole('button', { name: /FAMILY/ }))
    const file = new File(['<nzb/>'], 'sintel.nzb', { type: 'application/x-nzb' })
    fireEvent.change(screen.getByLabelText('Upload a .torrent or .nzb file'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to Family' }))
    await waitFor(() => expect(calls.find((call) => call.url === '/api/tomifin/download')?.body).toEqual({ resultId: 'd'.repeat(64), destination: 'family' }))
    const sent = calls.find((call) => call.url === '/api/tomifin/link')!.body as { file: { name: string; data: string } }
    expect(sent.file.name).toBe('sintel.nzb')
    expect(atob(sent.file.data)).toBe('<nzb/>')
  })

  it('shows why a link was refused', async () => {
    fakeApi({ link: () => Response.json({ error: 'unsafe-link', message: 'That link points at a private network address.' }, { status: 400 }) })
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: 'Magnet, .torrent or .nzb link' }), { target: { value: 'http://192.168.1.2/a.torrent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That link points at a private network address.')
  })

  it('lists SABnzbd downloads beside qBittorrent ones and says which downloader cancel removes from', async () => {
    fakeApi({ jobs: [job(), job({ id: '00000000-0000-4000-8000-000000000003', name: 'Sintel', downloader: 'sabnzbd', downloaderLabel: 'SABnzbd', type: 'usenet', status: 'completed', progress: 100, canPause: false, keepsFilesOnCancel: true })] })
    await open()
    const usenet = (await screen.findByText('Sintel')).closest('li')!
    expect(within(usenet).getByText(/SABnzbd/)).toBeInTheDocument()
    expect(within(usenet).getByText('Completed')).toBeInTheDocument()
  })

  it('shows the VPN status, and says when it is down', async () => {
    fakeApi()
    await open()
    expect(await screen.findByText('VPN connected · London, United Kingdom')).toBeInTheDocument()
  })

  it('warns when the VPN is down and hides the status when the agent cannot report it', async () => {
    fakeApi({ vpn: { state: 'down', qbittorrent: 'disconnected', nordvpn: null } })
    await open()
    expect(await screen.findByText('VPN down: downloads and searches are paused')).toBeInTheDocument()
    vi.unstubAllGlobals()
    fakeApi({ vpn: Response.json({ error: 'recovery-agent-outdated', message: 'old agent' }, { status: 409 }) })
    document.body.innerHTML = ''
    await open()
    await waitFor(() => expect(screen.queryByText(/^VPN /)).not.toBeInTheDocument())
    expect(screen.getByText(/Signed in as/)).toBeInTheDocument()
  })

  it('refreshes the downloads list on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = fakeApi({ jobs: [job()] })
    await open()
    await screen.findByText('Big Buck Bunny (2008)')
    const before = calls.filter((call) => call.url === '/api/tomifin/downloads').length
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(calls.filter((call) => call.url === '/api/tomifin/downloads').length).toBeGreaterThan(before)
  })
})

describe('Tomifin helpers', () => {
  it('sorts by relevance, then seeders', () => {
    const sorted = sortResults([{ ...results[1], title: 'Unrelated', seeders: 500 }, results[1], results[0]], 'relevance', 'big buck bunny 2160p')
    expect(sorted.map((result) => result.title)).toEqual(['Big Buck Bunny 2160p WEB-DL HDR', 'Big Buck Bunny (2008) 1080p BluRay x264', 'Unrelated'])
    expect(sortResults(results, 'seeders', '').map((result) => result.seeders)).toEqual([40, 12])
    expect(sortResults(results, 'size-asc', '').map((result) => result.size)).toEqual([1_500_000_000, 9_000_000_000])
  })

  it('formats sizes and times', () => {
    expect(formatSize(null)).toBe('—')
    expect(formatSize(1_500_000_000)).toBe('1.40 GB')
    expect(formatEta(30)).toBe('30s')
    expect(formatEta(3 * 3600 + 120)).toBe('3 hr 2 min')
    expect(formatEta(null)).toBe('—')
  })
})
