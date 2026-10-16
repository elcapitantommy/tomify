import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'
import { NavidromeError } from './navidrome'
import { revalidateCatalogueItems, type CataloguePlaylistItem } from './catalogue-import'

const moved: Track = { id: 'new-id', title: 'Birdhouse In Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 }
const entry = (overrides: Partial<CataloguePlaylistItem> = {}): CataloguePlaylistItem => ({ id: 'item-1', position: 0, status: 'available', title: 'Birdhouse in Your Soul - 2010 Remaster', artists: ['They Might Be Giants'], album: 'Flood', duration: 200, localTrackId: 'old-id', localTrack: { ...moved, id: 'old-id' }, ...overrides })

describe('revalidateCatalogueItems', () => {
  it('leaves available entries whose track still exists', async () => {
    const library = { song: vi.fn(async (id: string) => ({ ...moved, id })), search: vi.fn(async () => ({ tracks: [moved] })) }
    expect(await revalidateCatalogueItems([entry()], library)).toEqual([])
    expect(library.song).toHaveBeenCalledWith('old-id'); expect(library.search).not.toHaveBeenCalled()
  })

  it('re-matches an available entry whose Navidrome ID no longer exists', async () => {
    const library = { song: vi.fn(async () => { throw new NavidromeError('Song not found', 70) }), search: vi.fn(async () => ({ tracks: [moved] })) }
    expect(await revalidateCatalogueItems([entry()], library)).toEqual([{ id: 'item-1', localTrack: moved, matchConfidence: 98 }])
    expect(library.search).toHaveBeenCalledWith('They Might Be Giants Birdhouse in Your Soul')
  })

  it('marks a stale entry missing when nothing in the library matches any more', async () => {
    const library = { song: vi.fn(async () => { throw new NavidromeError('Song not found', 70) }), search: vi.fn(async () => ({ tracks: [] })) }
    expect(await revalidateCatalogueItems([entry()], library)).toEqual([{ id: 'item-1', missing: true }])
  })

  it('does not touch available entries when the server is unreachable', async () => {
    const library = { song: vi.fn(async () => { throw new NavidromeError('Tomify cannot reach the music server.') }), search: vi.fn(async () => ({ tracks: [] })) }
    expect(await revalidateCatalogueItems([entry()], library)).toEqual([])
    expect(library.search).not.toHaveBeenCalled()
  })

  it('resolves pending entries that now match and skips unavailable ones', async () => {
    const library = { song: vi.fn(), search: vi.fn(async () => ({ tracks: [moved] })) }
    const items = [entry({ id: 'missing-1', status: 'missing', localTrack: null, localTrackId: null }), entry({ id: 'gone', status: 'unavailable', localTrack: null, localTrackId: null })]
    expect(await revalidateCatalogueItems(items, library)).toEqual([{ id: 'missing-1', localTrack: moved, matchConfidence: 98 }])
    expect(library.song).not.toHaveBeenCalled()
  })
})
