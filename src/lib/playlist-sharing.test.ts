import { beforeEach, describe, expect, it, vi } from 'vitest'
import { playlistShareApi } from './playlist-shares'
import { saveNavidromePlaylistShares } from './playlist-sharing'

vi.mock('./playlist-shares', () => ({ playlistShareApi: { update: vi.fn(), list: vi.fn() } }))

describe('saveNavidromePlaylistShares', () => {
  const calls: string[] = []
  const api = { setPlaylistPublic: vi.fn(async (_id: string, isPublic: boolean) => { calls.push(`public:${isPublic}`) }) }
  beforeEach(() => { calls.length = 0; api.setPlaylistPublic.mockClear(); vi.mocked(playlistShareApi.update).mockReset() })

  it('makes the playlist public in Navidrome before recording the share', async () => {
    vi.mocked(playlistShareApi.update).mockImplementation(async (kind, playlistId, users) => { calls.push('share'); return { kind, playlistId, sharedWith: users } })
    expect(await saveNavidromePlaylistShares(api, 'p1', ['anna'])).toEqual(['anna'])
    expect(calls).toEqual(['public:true', 'share'])
  })

  it('makes the playlist private again once nobody is left on the share', async () => {
    vi.mocked(playlistShareApi.update).mockImplementation(async (kind, playlistId) => { calls.push('share'); return { kind, playlistId, sharedWith: [] } })
    expect(await saveNavidromePlaylistShares(api, 'p1', [])).toEqual([])
    expect(calls).toEqual(['share', 'public:false'])
  })
})
