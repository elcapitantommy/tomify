import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { NewReleases } from './NewReleases'

const api = { artists: vi.fn(async () => [{ id: 'ar1', name: 'Muse' }]), allAlbums: vi.fn(async () => [{ id: 'al1', name: 'Drones', artist: 'Muse' }]) }
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
const recoveryAdd = vi.fn(async () => ({ item: {} }))
vi.mock('../lib/recovery-api', () => ({ recoveryApi: { add: (input: unknown) => recoveryAdd(input) } }))

let fetchMock: ReturnType<typeof vi.fn>
let user = 0

function setup(isAdmin: boolean) {
  useAuth.setState({ session: { serverUrl: 'https://music.example', username: `user${++user}`, salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin })
  fetchMock = vi.fn(async (url: string) => url.startsWith('/api/new-releases?')
    ? Response.json({ releases: [{ id: 'g1', artist: 'Muse', title: 'Wow! Signal', type: 'album', date: '2026-09-26' }, { id: 'g0', artist: 'Muse', title: 'Drones', type: 'album', date: '2026-06-08' }], artists: 1, checked: 1 })
    : Response.json({ artists: 1 }))
  vi.stubGlobal('fetch', fetchMock)
}

describe('NewReleases', () => {
  beforeEach(() => { window.localStorage.clear(); recoveryAdd.mockClear() })
  afterEach(() => vi.unstubAllGlobals())

  it('lists records not in the library and lets an administrator add one to Recovery', async () => {
    setup(true)
    render(<NewReleases/>)
    expect(await screen.findByText('Wow! Signal')).toBeInTheDocument()
    expect(screen.queryByText('Drones')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/new-releases/artists')).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add to Recovery' })) })
    expect(recoveryAdd).toHaveBeenCalledWith({ artist: 'Muse', album: 'Wow! Signal' })
    expect(screen.getByRole('button', { name: 'In Recovery' })).toBeDisabled()
  })

  it('does not offer Recovery to other accounts', async () => {
    setup(false)
    render(<NewReleases/>)
    expect(await screen.findByText('Wow! Signal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to Recovery' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Wow! Signal by Muse on MusicBrainz' })).toHaveAttribute('href', 'https://musicbrainz.org/release-group/g1')
  })
})
