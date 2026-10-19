import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeIndexedDb } from '../test/fakeIndexedDb'
import { offlineAccount, resetOfflineDbForTests, saveCollection, saveTracks, type OfflineTrack } from '../lib/offline-db'
import { resetDownloadsForTests, useDownloads } from '../stores/downloads'
import { usePlayer } from '../stores/player'
import { CollectionDownloadButton, TrackDownloadButton } from '../components/DownloadButton'
import { Downloads } from './Downloads'
import type { Track } from '../types'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const account = offlineAccount(session)
const song = (id: string): Track => ({ id, title: `Song ${id}`, artist: 'Pixies', album: 'Doolittle' })
const record = (id: string, owners: string[], status: OfflineTrack['status'] = 'available-offline', extra: Partial<OfflineTrack> = {}): OfflineTrack => ({ id, track: song(id), status, owners, bytes: 2 * 1024 * 1024, addedAt: 1, updatedAt: 1, ...extra })

describe('Downloads', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new FakeIndexedDb())
    // Downloads queued by these tests never reach a server.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))))
    resetOfflineDbForTests()
    resetDownloadsForTests()
    usePlayer.setState({ queue: [], currentIndex: 0, playing: false })
  })
  afterEach(() => { resetDownloadsForTests(); vi.unstubAllGlobals(); delete (navigator as { storage?: unknown }).storage })

  it('lists what is on the device with real storage figures, and plays, retries and removes it', async () => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1024 ** 3, quota: 5 * 1024 ** 3 }), persisted: async () => true } })
    await saveTracks(account, [record('t1', ['album:al-1']), record('t2', ['album:al-1'], 'failed', { error: 'The music server returned 500.', bytes: undefined }), record('t3', ['track'])])
    await saveCollection(account, { key: 'album:al-1', kind: 'album', id: 'al-1', name: 'Doolittle', artist: 'Pixies', trackIds: ['t1', 't2'], addedAt: 1, updatedAt: 1 })
    await useDownloads.getState().bind(session)
    render(<MemoryRouter><Downloads/></MemoryRouter>)

    expect(screen.getByText('4.0 MB')).toBeInTheDocument()
    expect(await screen.findByText('4.0 GB of 5.0 GB')).toBeInTheDocument()
    expect(await screen.findByText('Kept until you remove it')).toBeInTheDocument()
    const album = screen.getByText('Doolittle').closest('li')!
    expect(within(album).getByText('1 of 2 failed')).toBeInTheDocument()
    expect(within(album).getByText('The music server returned 500.')).toBeInTheDocument()

    fireEvent.click(within(album).getByRole('button', { name: 'Play Doolittle' }))
    expect(usePlayer.getState().queue.map((track) => track.id)).toEqual(['t1'])

    fireEvent.click(within(album).getByRole('button', { name: 'Retry Doolittle' }))
    await waitFor(() => expect(useDownloads.getState().tracks.t2.status).not.toBe('failed'))

    const single = screen.getByText('Song t3').closest('li')!
    expect(within(single).getByText('Available offline')).toBeInTheDocument()
    fireEvent.click(within(single).getByRole('button', { name: 'Remove Song t3 from downloads' }))
    await waitFor(() => expect(screen.queryByText('Song t3')).not.toBeInTheDocument())

    fireEvent.click(within(album).getByRole('button', { name: 'Remove Doolittle from downloads' }))
    expect(await screen.findByText('Nothing downloaded yet')).toBeInTheDocument()
  })

  it('says so when the browser cannot store music', () => {
    vi.stubGlobal('indexedDB', undefined)
    resetDownloadsForTests()
    render(<MemoryRouter><Downloads/></MemoryRouter>)
    expect(screen.getByText('This browser can’t keep music offline')).toBeInTheDocument()
  })

  it('offers Download on tracks and albums, then shows their progress', async () => {
    await useDownloads.getState().bind(session)
    render(<MemoryRouter><TrackDownloadButton track={song('t1')}/><CollectionDownloadButton kind="album" item={{ id: 'al-1', name: 'Doolittle' }} tracks={[song('t1'), song('t2')]}/></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Download Song t1' }))
    expect(await screen.findByRole('button', { name: 'Downloading Song t1' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('button', { name: /Downloading 0 of 2/ })).toBeDisabled()
    expect(useDownloads.getState().tracks.t1.owners).toEqual(['track', 'album:al-1'])
  })

  it('shows a finished album as downloaded and a changed playlist as needing an update', async () => {
    await saveTracks(account, [record('t1', ['album:al-1', 'playlist:pl-1']), record('t2', ['album:al-1'])])
    await saveCollection(account, { key: 'album:al-1', kind: 'album', id: 'al-1', name: 'Doolittle', trackIds: ['t1', 't2'], addedAt: 1, updatedAt: 1 })
    await saveCollection(account, { key: 'playlist:pl-1', kind: 'playlist', id: 'pl-1', name: 'Mix', trackIds: ['t1'], addedAt: 1, updatedAt: 1 })
    await useDownloads.getState().bind(session)
    render(<MemoryRouter>
      <CollectionDownloadButton kind="album" item={{ id: 'al-1', name: 'Doolittle' }} tracks={[song('t1'), song('t2')]}/>
      <CollectionDownloadButton kind="playlist" item={{ id: 'pl-1', name: 'Mix' }} tracks={[song('t1'), song('t2')]}/>
      <TrackDownloadButton track={song('t2')}/>
    </MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Downloaded' })).toHaveAttribute('href', '/downloads')
    expect(screen.getByRole('button', { name: 'Update download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Song t2 is downloaded' })).toBeDisabled()
  })
})
