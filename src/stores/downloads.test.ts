import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeIndexedDb } from '../test/fakeIndexedDb'
import { NavidromeClient } from '../lib/navidrome'
import { LocalFirstSourceResolver } from '../lib/sourceResolver'
import { cachedLocalAudioUrl, localAudioUrl, offlineAccount, resetOfflineDbForTests, storeDownload } from '../lib/offline-db'
import { QUOTA_MESSAGE, resetDownloadsForTests, summariseDownloads, useDownloads } from './downloads'
import { useDownloadQuality } from './downloadQuality'
import type { Track } from '../types'

const session = { serverUrl: 'https://music.example', username: 'Tom', salt: 's', token: 't' }
const account = offlineAccount(session)
const dbName = `tomify-offline:${account}`
const song = (id: string, extra: Partial<Track> = {}): Track => ({ id, title: `Song ${id}`, artist: 'They Might Be Giants', album: 'Flood', coverArt: 'al-flood', ...extra })
const audioBytes = (id: string) => new TextEncoder().encode(`audio-of-${id}`)

let idb: FakeIndexedDb
let requests: string[]
let respond: (url: URL) => Response | Promise<Response>
let urls: number

const audioResponse = (id: string) => new Response(audioBytes(id), { headers: { 'content-type': 'audio/flac', 'content-length': String(audioBytes(id).byteLength) } })
const defaultResponse = (url: URL) => {
  if (url.pathname.endsWith('/getCoverArt.view')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
  return audioResponse(url.searchParams.get('id')!)
}
const status = (id: string) => useDownloads.getState().tracks[id]?.status
const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 })

describe('offline downloads', () => {
  beforeEach(async () => {
    idb = new FakeIndexedDb()
    vi.stubGlobal('indexedDB', idb)
    requests = []
    urls = 0
    respond = defaultResponse
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => { const url = new URL(String(input)); requests.push(url.toString()); return respond(url) }))
    URL.createObjectURL = vi.fn(() => `blob:tomify/${++urls}`)
    URL.revokeObjectURL = vi.fn()
    resetOfflineDbForTests()
    resetDownloadsForTests()
    await useDownloads.getState().bind(session)
  })

  afterEach(() => {
    useDownloadQuality.setState({ quality: 'original' })
    resetDownloadsForTests()
    vi.unstubAllGlobals()
    delete (navigator as { storage?: unknown }).storage
  })

  it('downloads a track as the original file and plays it from the device', async () => {
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('available-offline'))

    const stream = new URL(requests.find((url) => url.includes('/rest/stream.view'))!)
    expect(stream.searchParams.get('id')).toBe('t1')
    expect(stream.searchParams.get('format')).toBe('raw')
    expect(requests.some((url) => url.includes('/api/hls/'))).toBe(false)
    expect(useDownloads.getState().tracks.t1.bytes).toBe(audioBytes('t1').byteLength)
    expect(idb.contents(dbName, 'files').has('audio:t1')).toBe(true)
    expect(idb.contents(dbName, 'files').has('art:al-flood')).toBe(true)

    const resolver = new LocalFirstSourceResolver(new NavidromeClient(session))
    expect(await resolver.resolve(song('t1'))).toEqual({ url: 'blob:tomify/1', kind: 'local' })
    expect(cachedLocalAudioUrl(session, 't1')).toBe('blob:tomify/1')
    const streamed = await resolver.resolve(song('t2'))
    expect(streamed.kind).toBe('stream')
    expect(new URL(streamed.url).searchParams.get('id')).toBe('t2')
  })

  it('downloads an album and a playlist, sharing songs between them, and removes only what nothing else keeps', async () => {
    const state = useDownloads.getState()
    await state.downloadTracks([song('t1')])
    await state.downloadCollection('album', { id: 'al-flood', name: 'Flood', artist: 'They Might Be Giants', coverArt: 'al-flood' }, [song('t1'), song('t2')])
    await state.downloadCollection('playlist', { id: 'pl-1', name: 'Road trip' }, [song('t2'), song('t3', { coverArt: 'al-other' })])
    await until(() => expect(['t1', 't2', 't3'].map(status)).toEqual(['available-offline', 'available-offline', 'available-offline']))
    // Each song is fetched once, however many downloads include it.
    expect(requests.filter((url) => url.includes('/rest/stream.view'))).toHaveLength(3)
    expect(useDownloads.getState().tracks.t2.owners).toEqual(['album:al-flood', 'playlist:pl-1'])
    expect(summariseDownloads(['t1', 't2'], useDownloads.getState().tracks)).toMatchObject({ status: 'available-offline', done: 2, total: 2 })

    await localAudioUrl(session, 't3')
    await useDownloads.getState().removeCollection('playlist:pl-1')
    expect(status('t3')).toBeUndefined()
    expect(status('t2')).toBe('available-offline')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tomify/1')
    await until(() => expect(idb.contents(dbName, 'files').has('audio:t3')).toBe(false))
    expect(idb.contents(dbName, 'files').has('art:al-other')).toBe(false)
    expect(idb.contents(dbName, 'collections').has('playlist:pl-1')).toBe(false)

    await useDownloads.getState().removeCollection('album:al-flood')
    expect(status('t2')).toBeUndefined()
    expect(status('t1')).toBe('available-offline')
    expect(idb.contents(dbName, 'files').has('art:al-flood')).toBe(true)
    await useDownloads.getState().removeTrack('t1')
    expect(useDownloads.getState().tracks).toEqual({})
    await until(() => expect([...idb.contents(dbName, 'files').keys()]).toEqual([]))
  })

  it('updates a downloaded playlist, releasing songs taken out of it', async () => {
    const { downloadCollection } = useDownloads.getState()
    await downloadCollection('playlist', { id: 'pl-1', name: 'Road trip' }, [song('t1'), song('t2')])
    await until(() => expect(status('t2')).toBe('available-offline'))
    await downloadCollection('playlist', { id: 'pl-1', name: 'Road trip' }, [song('t3'), song('t1')])
    expect(status('t2')).toBeUndefined()
    expect(useDownloads.getState().collections['playlist:pl-1'].trackIds).toEqual(['t3', 't1'])
    await until(() => expect(status('t3')).toBe('available-offline'))
  })

  it('downloads a smaller MP3 when a smaller download quality is chosen, keeping songs already saved as they are', async () => {
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('available-offline'))
    useDownloadQuality.getState().setQuality('small')
    await useDownloads.getState().downloadTracks([song('t1'), song('t2', { duration: 100 })])
    await until(() => expect(status('t2')).toBe('available-offline'))

    const streams = requests.filter((url) => url.includes('/rest/stream.view')).map((url) => new URL(url).searchParams)
    expect(streams).toHaveLength(2)
    expect(streams[1].get('id')).toBe('t2')
    expect(streams[1].get('format')).toBe('mp3')
    expect(streams[1].get('maxBitRate')).toBe('128')
    expect(useDownloads.getState().tracks.t1.quality).toBe('original')
    expect(useDownloads.getState().tracks.t2.quality).toBe('small')
  })

  it('retries a failed download in the quality chosen now', async () => {
    respond = () => new Response('nope', { status: 500 })
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('failed'))
    respond = defaultResponse
    useDownloadQuality.getState().setQuality('high')
    await useDownloads.getState().retry(['t1'])
    await until(() => expect(status('t1')).toBe('available-offline'))
    const last = new URL(requests.filter((url) => url.includes('/rest/stream.view')).at(-1)!)
    expect(last.searchParams.get('maxBitRate')).toBe('320')
  })

  describe('downloaded playlists', () => {
    let serverPlaylist: { id: string; name: string; owner: string; entry: Track[] } | null
    beforeEach(() => {
      serverPlaylist = null
      respond = (url) => {
        if (url.pathname.endsWith('/getPlaylist.view')) {
          if (!serverPlaylist) return Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'Playlist not found' } } })
          return Response.json({ 'subsonic-response': { status: 'ok', playlist: serverPlaylist } })
        }
        return defaultResponse(url)
      }
    })
    const playlistRequests = () => requests.filter((url) => url.includes('/rest/getPlaylist.view'))

    it('update themselves from the server: new songs download and removed ones are let go', async () => {
      await useDownloads.getState().downloadCollection('playlist', { id: 'pl-1', name: 'Road trip', owner: 'Tom' }, [song('t1'), song('t2')])
      await until(() => expect(status('t2')).toBe('available-offline'))
      serverPlaylist = { id: 'pl-1', name: 'Road trip 2026', owner: 'Tom', entry: [song('t3'), song('t1')] }

      await useDownloads.getState().syncPlaylists()
      expect(useDownloads.getState().collections['playlist:pl-1']).toMatchObject({ name: 'Road trip 2026', trackIds: ['t3', 't1'] })
      expect(status('t2')).toBeUndefined()
      await until(() => expect(status('t3')).toBe('available-offline'))
    })

    it('are checked when Tomify opens, and left alone when nothing changed', async () => {
      await useDownloads.getState().downloadCollection('playlist', { id: 'pl-1', name: 'Road trip', owner: 'Tom' }, [song('t1')])
      await until(() => expect(status('t1')).toBe('available-offline'))
      serverPlaylist = { id: 'pl-1', name: 'Road trip', owner: 'Tom', entry: [song('t1'), song('t2')] }
      resetDownloadsForTests()
      resetOfflineDbForTests()
      await useDownloads.getState().bind(session)
      await until(() => expect(status('t2')).toBe('available-offline'))
      expect(playlistRequests()).toHaveLength(1)

      const streams = requests.filter((url) => url.includes('/rest/stream.view')).length
      await useDownloads.getState().syncPlaylists()
      expect(playlistRequests()).toHaveLength(2)
      expect(requests.filter((url) => url.includes('/rest/stream.view'))).toHaveLength(streams)
    })

    it('keep what is on the device when the server no longer has the playlist', async () => {
      await useDownloads.getState().downloadCollection('playlist', { id: 'pl-1', name: 'Road trip', owner: 'Tom' }, [song('t1')])
      await until(() => expect(status('t1')).toBe('available-offline'))
      await useDownloads.getState().syncPlaylists()
      expect(playlistRequests()).toHaveLength(1)
      expect(useDownloads.getState().collections['playlist:pl-1'].trackIds).toEqual(['t1'])
      expect(status('t1')).toBe('available-offline')
    })

    it('read a playlist shared by someone else as that owner\'s', async () => {
      await useDownloads.getState().downloadCollection('playlist', { id: 'pl-anna', name: 'Anna mix', owner: 'anna' }, [song('t1')])
      await until(() => expect(status('t1')).toBe('available-offline'))
      serverPlaylist = { id: 'pl-anna', name: 'Anna mix', owner: 'anna', entry: [song('t1'), song('t5')] }
      await useDownloads.getState().syncPlaylists()
      await until(() => expect(status('t5')).toBe('available-offline'))
    })

    it('wait while the phone is on mobile data', async () => {
      await useDownloads.getState().downloadCollection('playlist', { id: 'pl-1', name: 'Road trip', owner: 'Tom' }, [song('t1')])
      Object.defineProperty(navigator, 'connection', { configurable: true, value: { type: 'cellular' } })
      try {
        await useDownloads.getState().syncPlaylists()
        expect(playlistRequests()).toHaveLength(0)
      } finally {
        delete (navigator as { connection?: unknown }).connection
      }
    })
  })

  it('marks a failed download and retries it', async () => {
    respond = () => new Response('nope', { status: 500 })
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('failed'))
    expect(useDownloads.getState().tracks.t1.error).toBe('The music server returned 500.')
    expect(await localAudioUrl(session, 't1')).toBeUndefined()

    respond = defaultResponse
    await useDownloads.getState().retry(['t1'])
    await until(() => expect(status('t1')).toBe('available-offline'))
    expect(useDownloads.getState().tracks.t1.error).toBeUndefined()
  })

  it('reports a refusal the music server sends as a Subsonic error', async () => {
    respond = () => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 50, message: 'User not authorized' } } })
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(useDownloads.getState().tracks.t1.error).toBe('User not authorized'))
    expect(status('t1')).toBe('failed')
  })

  it('stops the queue cleanly when the device runs out of space', async () => {
    idb.failPut = (store, value) => store === 'files' && String(value.key).startsWith('audio:') ? new DOMException('Quota exceeded', 'QuotaExceededError') : null
    await useDownloads.getState().downloadTracks([song('t1'), song('t2')])
    await until(() => expect([status('t1'), status('t2')]).toEqual(['failed', 'failed']))
    expect(useDownloads.getState().tracks.t1.error).toBe(QUOTA_MESSAGE)
    expect(useDownloads.getState().notice).toBe(QUOTA_MESSAGE)
    expect(requests.filter((url) => url.includes('/rest/stream.view'))).toHaveLength(1)
    // Nothing half-written is left behind.
    expect(idb.contents(dbName, 'files').has('audio:t1')).toBe(false)
  })

  it('checks the space left before fetching and asks the browser to keep downloads', async () => {
    const persist = vi.fn(async () => true)
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist, persisted: async () => false, estimate: async () => ({ usage: 900, quota: 1000 }) } })
    await useDownloads.getState().downloadTracks([song('t1', { size: 5000 })])
    await until(() => expect(status('t1')).toBe('failed'))
    expect(useDownloads.getState().tracks.t1.error).toBe(QUOTA_MESSAGE)
    expect(requests.some((url) => url.includes('/rest/stream.view'))).toBe(false)
    expect(persist).toHaveBeenCalled()
    await until(() => expect(useDownloads.getState().persisted).toBe(true))
  })

  it('keeps downloads across a restart and resumes one that was interrupted', async () => {
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('available-offline'))
    await useDownloads.getState().downloadTracks([song('t2')])
    resetDownloadsForTests()
    resetOfflineDbForTests()
    expect(useDownloads.getState().tracks).toEqual({})
    await useDownloads.getState().bind(session)
    expect(status('t1')).toBe('available-offline')
    await until(() => expect(status('t2')).toBe('available-offline'))
  })

  it('streams instead of playing a stored copy that does not match what was downloaded', async () => {
    const record = { id: 't9', track: song('t9'), status: 'available-offline' as const, owners: ['track'], bytes: 999, addedAt: 1, updatedAt: 1 }
    await storeDownload(account, record, new Blob([audioBytes('t9')]))
    const source = await new LocalFirstSourceResolver(new NavidromeClient(session)).resolve(song('t9'))
    expect(source.kind).toBe('stream')
  })

  it('keeps each account\'s downloads apart', async () => {
    await useDownloads.getState().downloadTracks([song('t1')])
    await until(() => expect(status('t1')).toBe('available-offline'))
    await useDownloads.getState().bind({ ...session, username: 'anna' })
    expect(useDownloads.getState().tracks).toEqual({})
    expect(await localAudioUrl({ ...session, username: 'anna' }, 't1')).toBeUndefined()
  })
})
