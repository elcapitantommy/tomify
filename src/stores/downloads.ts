import { create } from 'zustand'
import { NavidromeClient, type AuthSession } from '../lib/navidrome'
import { artKey, collectionKey, deleteCollection, deleteTracks, forgetLocalAudio, isQuotaError, offlineAccount, offlineSupported, readFile, readLibrary, saveCollection, saveTracks, storeDownload, storeFile, TRACK_OWNER, type CollectionKind, type OfflineCollection, type OfflineTrack } from '../lib/offline-db'
import type { DownloadStatus, Track } from '../types'
import { downloadBitRate, useDownloadQuality, type DownloadQuality } from './downloadQuality'

// Offline downloads: the queue runs one song at a time in the background (one at a time keeps
// a phone's memory and connection free for playback), from the Navidrome stream URL: format=raw
// for the original file, or an MP3 the server makes for the smaller download qualities (never HLS chunks).
// Downloaded playlists keep themselves up to date: Tomify checks them against the server when it
// opens, comes back online or comes back to the foreground (see syncPlaylists).

export const QUOTA_MESSAGE = 'Not enough storage space on this device. Remove some downloads, then retry.'
const OFFLINE_MESSAGE = 'Waiting for a connection.'

export interface CollectionInput { id: string; name: string; artist?: string; owner?: string; coverArt?: string }
export interface DownloadSummary { status: DownloadStatus; total: number; done: number; failed: number; bytes: number; error?: string }

interface DownloadsState {
  supported: boolean
  ready: boolean
  account: string | null
  tracks: Record<string, OfflineTrack>
  collections: Record<string, OfflineCollection>
  // Share of the song downloaded so far (0 to 1), for the one downloading now.
  progress: Record<string, number>
  persisted: boolean | null
  notice: string | null
  bind(session: AuthSession | null): Promise<void>
  downloadTracks(tracks: Track[]): Promise<void>
  downloadCollection(kind: CollectionKind, item: CollectionInput, tracks: Track[]): Promise<void>
  removeTrack(id: string): Promise<void>
  removeCollection(key: string): Promise<void>
  retry(ids: string[]): Promise<void>
  syncPlaylists(): Promise<void>
}

let client: NavidromeClient | null = null
let active: { account: string; id: string; controller: AbortController } | null = null
let pumping = false
let listening = false
let syncing = false
let lastSync = 0
// How often the downloaded playlists are checked for changes, at most.
export const PLAYLIST_SYNC_INTERVAL_MS = 15 * 60_000

const now = () => Date.now()
const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback
const unique = (ids: string[]) => [...new Set(ids)]
const currentQuality = (): DownloadQuality => useDownloadQuality.getState().quality
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false
// Automatic updates wait when the phone says it is on mobile data or in data saver mode (Android Chrome
// reports this; iPhone Safari does not, so there they run on any connection).
function meteredConnection() {
  const connection = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection
  return Boolean(connection && (connection.saveData || connection.type === 'cellular'))
}

export const useDownloads = create<DownloadsState>()((set, get) => {
  // State is updated first so the page reacts at once; IndexedDB follows. A failed write is reported, not hidden.
  async function persistTracks(account: string, records: OfflineTrack[]) {
    if (!records.length || get().account !== account) return
    set((state) => ({ tracks: { ...state.tracks, ...Object.fromEntries(records.map((record) => [record.id, record])) } }))
    try { await saveTracks(account, records) } catch (error) { set({ notice: isQuotaError(error) ? QUOTA_MESSAGE : errorMessage(error, 'Downloads could not be saved.') }) }
  }

  async function forget(account: string, ids: string[], candidateArt: (string | undefined)[]) {
    if (!ids.length && !candidateArt.length) return
    if (active && active.account === account && ids.includes(active.id)) active.controller.abort()
    forgetLocalAudio(account, ids)
    set((state) => {
      const tracks = { ...state.tracks }
      const progress = { ...state.progress }
      ids.forEach((id) => { delete tracks[id]; delete progress[id] })
      return { tracks, progress }
    })
    // Artwork goes once nothing left on the device shows it.
    const { tracks, collections } = get()
    const used = new Set([...Object.values(tracks).map((record) => record.track.coverArt), ...Object.values(collections).map((collection) => collection.coverArt)])
    const orphanArt = unique(candidateArt.filter((coverArt): coverArt is string => Boolean(coverArt) && !used.has(coverArt))).map(artKey)
    await deleteTracks(account, ids, orphanArt).catch(() => undefined)
  }

  // Adds an owner to each song, queueing the ones not on the device yet (and any that failed).
  async function link(account: string, owner: string, tracks: Track[]) {
    const { tracks: existing } = get()
    const records = unique(tracks.map((track) => track.id)).map((id) => {
      const track = tracks.find((candidate) => candidate.id === id)!
      const record = existing[id]
      if (!record) return { id, track, status: 'queued', owners: [owner], quality: currentQuality(), addedAt: now(), updatedAt: now() } satisfies OfflineTrack
      const status = record.status === 'failed' ? 'queued' : record.status
      return { ...record, track: record.status === 'available-offline' ? record.track : track, owners: unique([...record.owners, owner]), status, quality: record.status === 'failed' ? currentQuality() : record.quality, error: status === 'queued' ? undefined : record.error, updatedAt: now() }
    })
    await persistTracks(account, records)
  }

  // Takes an owner off each song; a song nothing owns any more is deleted with its audio.
  async function unlink(account: string, owner: string, ids: string[]) {
    const { tracks } = get()
    const kept: OfflineTrack[] = []
    const dropped: string[] = []
    ids.forEach((id) => {
      const record = tracks[id]
      if (!record || !record.owners.includes(owner)) return
      const owners = record.owners.filter((candidate) => candidate !== owner)
      if (owners.length) kept.push({ ...record, owners, updatedAt: now() })
      else dropped.push(id)
    })
    await persistTracks(account, kept)
    await forget(account, dropped, dropped.map((id) => tracks[id]?.track.coverArt))
  }

  async function requestPersistence() {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (!storage?.persist) return
    try {
      const already = await storage.persisted?.()
      set({ persisted: already ? true : await storage.persist() })
    } catch { /* the browser decides; downloads still work without it */ }
  }

  // A download that clearly won't fit fails before any of it is fetched.
  async function ensureSpace(size?: number) {
    if (!size || typeof navigator === 'undefined' || !navigator.storage?.estimate) return
    const estimate = await navigator.storage.estimate().catch(() => null)
    if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < size * 1.05) throw new DOMException(QUOTA_MESSAGE, 'QuotaExceededError')
  }

  async function fetchAudio(url: string, track: Track, expectedSize: number | undefined, signal: AbortSignal, onProgress: (share: number) => void) {
    const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' }).catch((error: unknown) => {
      if (signal.aborted) throw error
      throw new Error('Tomify cannot reach the music server.')
    })
    if (!response.ok) throw new Error(`The music server returned ${response.status}.`)
    const type = response.headers.get('content-type') ?? ''
    // Subsonic reports a refused stream as a JSON or XML body with status 200.
    if (/json|xml|^text\//i.test(type)) {
      const body = await response.json().catch(() => null) as { 'subsonic-response'?: { error?: { message?: string } } } | null
      throw new Error(body?.['subsonic-response']?.error?.message ?? 'The music server refused the download.')
    }
    const total = Number(response.headers.get('content-length')) || expectedSize || 0
    const chunks: BlobPart[] = []
    if (response.body) {
      const reader = response.body.getReader()
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        if (total) onProgress(Math.min(1, received / total))
      }
    } else {
      chunks.push(await response.blob())
    }
    const blob = new Blob(chunks, { type: type || track.contentType || 'audio/mpeg' })
    if (blob.size === 0) throw new Error('The music server sent an empty file.')
    return blob
  }

  async function fetchArtwork(account: string, coverArt: string | undefined, signal?: AbortSignal) {
    if (!coverArt || !client) return undefined
    if (await readFile(account, artKey(coverArt)).catch(() => undefined)) return undefined
    try {
      const response = await fetch(client.coverArtUrl(coverArt, 600), { signal, credentials: 'omit' })
      const blob = response.ok ? await response.blob() : null
      return blob && blob.size > 0 && /^image\//.test(blob.type) ? { key: artKey(coverArt), blob } : undefined
    } catch {
      return undefined
    }
  }

  function failQueued(account: string, message: string) {
    const records = Object.values(get().tracks).filter((record) => record.status === 'queued').map((record) => ({ ...record, status: 'failed' as const, error: message, updatedAt: now() }))
    return persistTracks(account, records)
  }

  async function downloadOne(account: string, queued: OfflineTrack) {
    if (!client) return
    const controller = new AbortController()
    active = { account, id: queued.id, controller }
    const stillWanted = () => !controller.signal.aborted && get().account === account && Boolean(get().tracks[queued.id])
    set((state) => ({ tracks: { ...state.tracks, [queued.id]: { ...queued, status: 'downloading', error: undefined } }, progress: { ...state.progress, [queued.id]: 0 } }))
    try {
      // A smaller quality is an MP3 the server makes as it goes, so it sends no size: estimate it from the length.
      const kbps = downloadBitRate(queued.quality)
      const expectedSize = kbps ? (queued.track.duration ? Math.round(queued.track.duration * kbps * 125) : undefined) : queued.track.size
      await ensureSpace(expectedSize)
      const url = client.url('stream', kbps ? { id: queued.id, format: 'mp3', maxBitRate: kbps } : { id: queued.id, format: 'raw' }).toString()
      const audio = await fetchAudio(url, queued.track, expectedSize, controller.signal, (share) => set((state) => ({ progress: { ...state.progress, [queued.id]: share } })))
      const artwork = await fetchArtwork(account, queued.track.coverArt, controller.signal)
      if (!stillWanted()) return
      const latest = get().tracks[queued.id]!
      const done: OfflineTrack = { ...latest, status: 'available-offline', bytes: audio.size, error: undefined, updatedAt: now() }
      await storeDownload(account, done, audio, artwork)
      // Removed while it was being written: take the copy straight back out.
      if (!stillWanted()) { if (get().account === account && !get().tracks[queued.id]) await deleteTracks(account, [queued.id]).catch(() => undefined); return }
      set((state) => ({ tracks: { ...state.tracks, [queued.id]: { ...state.tracks[queued.id]!, ...done, owners: state.tracks[queued.id]!.owners } } }))
    } catch (error) {
      if (!stillWanted()) return
      const latest = get().tracks[queued.id]!
      if (isQuotaError(error)) {
        // Every later download would hit the same wall, so the whole queue stops until space is freed.
        set({ notice: QUOTA_MESSAGE })
        await persistTracks(account, [{ ...latest, status: 'failed', error: QUOTA_MESSAGE, updatedAt: now() }])
        await failQueued(account, QUOTA_MESSAGE)
      } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        // Lost the connection: wait in the queue and carry on when it comes back.
        await persistTracks(account, [{ ...latest, status: 'queued', error: OFFLINE_MESSAGE, updatedAt: now() }])
      } else {
        await persistTracks(account, [{ ...latest, status: 'failed', error: errorMessage(error, 'The download failed.'), updatedAt: now() }])
      }
    } finally {
      if (active?.controller === controller) active = null
      set((state) => { const progress = { ...state.progress }; delete progress[queued.id]; return { progress } })
    }
  }

  // One queue runner at a time; a call while it runs is picked up by its loop.
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        const { account, tracks } = get()
        if (!account || !client || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
        const next = Object.values(tracks).filter((record) => record.status === 'queued').sort((a, b) => a.addedAt - b.addedAt)[0]
        if (!next) return
        await downloadOne(account, next)
      }
    } finally {
      pumping = false
    }
  }

  // Saves an album or playlist download and links its songs; a playlist that changed lets go of the songs taken out.
  async function collect(account: string, kind: CollectionKind, item: CollectionInput, tracks: Track[]) {
    const key = collectionKey(kind, item.id)
    const previous = get().collections[key]
    const trackIds = unique(tracks.map((track) => track.id))
    const collection: OfflineCollection = { key, kind, id: item.id, name: item.name, artist: item.artist, owner: item.owner ?? previous?.owner, coverArt: item.coverArt, trackIds, addedAt: previous?.addedAt ?? now(), updatedAt: now() }
    set((state) => ({ collections: { ...state.collections, [key]: collection } }))
    try { await saveCollection(account, collection) } catch (error) { set({ notice: isQuotaError(error) ? QUOTA_MESSAGE : errorMessage(error, 'The download could not be saved.') }); return }
    await link(account, key, tracks)
    if (previous) await unlink(account, key, previous.trackIds.filter((id) => !trackIds.includes(id)))
    void pump()
    // The album or playlist cover, for the Downloads page with no connection.
    if (item.coverArt && item.coverArt !== previous?.coverArt) void fetchArtwork(account, item.coverArt).then((art) => art && get().account === account ? storeFile(account, art.key, art.blob) : undefined).catch(() => undefined)
  }

  // Brings each downloaded playlist in line with the server: new songs download, removed ones are let go,
  // and a rename shows on the Downloads page. A playlist the server no longer has (deleted, or no longer
  // shared) keeps what is on the device; Remove on the Downloads page clears it.
  async function syncPlaylists(force = false) {
    const { account, ready } = get()
    if (!account || !ready || !client || syncing || offline() || meteredConnection()) return
    if (!force && now() - lastSync < PLAYLIST_SYNC_INTERVAL_MS) return
    syncing = true
    lastSync = now()
    const server = client
    try {
      for (const collection of Object.values(get().collections).filter((item) => item.kind === 'playlist')) {
        if (get().account !== account || client !== server) return
        const playlist = await server.playlist(collection.id, undefined, collection.owner).catch(() => null)
        // Removed from downloads while the server was being asked.
        if (!playlist || !get().collections[collection.key]) continue
        const tracks = playlist.entry ?? []
        const ids = unique(tracks.map((track) => track.id))
        const unchanged = playlist.name === collection.name && ids.length === collection.trackIds.length && ids.every((id, index) => id === collection.trackIds[index])
        if (unchanged) continue
        await collect(account, 'playlist', { id: collection.id, name: playlist.name, owner: playlist.owner ?? collection.owner, coverArt: playlist.coverArt ?? collection.coverArt }, tracks)
      }
    } finally {
      syncing = false
    }
  }

  return {
    supported: offlineSupported(),
    ready: false,
    account: null,
    tracks: {},
    collections: {},
    progress: {},
    persisted: null,
    notice: null,

    bind: async (session) => {
      const account = session && offlineSupported() ? offlineAccount(session) : null
      client = session ? new NavidromeClient(session) : null
      if (account === get().account && get().ready) { void pump(); return }
      active?.controller.abort()
      set({ supported: offlineSupported(), ready: false, account, tracks: {}, collections: {}, progress: {}, notice: null })
      if (!account) return
      if (!listening && typeof window !== 'undefined') {
        listening = true
        window.addEventListener('online', () => { void pump(); void syncPlaylists(true) })
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncPlaylists() })
      }
      try {
        const library = await readLibrary(account)
        if (get().account !== account) return
        // A song nothing owns is left over from an interrupted removal; a "downloading" one from a closed app goes back in the queue.
        const orphans = library.tracks.filter((record) => !record.owners.length).map((record) => record.id)
        const tracks = library.tracks.filter((record) => record.owners.length).map((record) => record.status === 'downloading' ? { ...record, status: 'queued' as const } : record)
        set({ ready: true, tracks: Object.fromEntries(tracks.map((record) => [record.id, record])), collections: Object.fromEntries(library.collections.map((collection) => [collection.key, collection])) })
        if (orphans.length) await deleteTracks(account, orphans).catch(() => undefined)
        const persisted = await (navigator.storage?.persisted?.() ?? Promise.resolve(null)).catch(() => null)
        set({ persisted })
        void pump()
        void syncPlaylists(true)
      } catch (error) {
        if (get().account === account) set({ ready: false, supported: false, notice: errorMessage(error, 'Offline storage is not available in this browser.') })
      }
    },

    downloadTracks: async (tracks) => {
      const { account, ready } = get()
      if (!account || !ready || !tracks.length) return
      set({ notice: null })
      void requestPersistence()
      await link(account, TRACK_OWNER, tracks)
      void pump()
    },

    downloadCollection: async (kind, item, tracks) => {
      const { account, ready } = get()
      if (!account || !ready) return
      set({ notice: null })
      void requestPersistence()
      await collect(account, kind, item, tracks)
    },

    syncPlaylists: () => syncPlaylists(true),

    removeTrack: async (id) => {
      const { account } = get()
      if (account) await unlink(account, TRACK_OWNER, [id])
    },

    removeCollection: async (key) => {
      const { account, collections } = get()
      const collection = collections[key]
      if (!account || !collection) return
      set((state) => { const next = { ...state.collections }; delete next[key]; return { collections: next } })
      await deleteCollection(account, key).catch(() => undefined)
      await unlink(account, key, collection.trackIds)
      await forget(account, [], [collection.coverArt])
    },

    retry: async (ids) => {
      const { account, tracks } = get()
      if (!account) return
      set({ notice: null })
      await persistTracks(account, ids.map((id) => tracks[id]).filter((record): record is OfflineTrack => record?.status === 'failed').map((record) => ({ ...record, status: 'queued', quality: currentQuality(), error: undefined, updatedAt: now() })))
      void pump()
    },
  }
})

// How far along a set of songs is, for an album or playlist button and the Downloads page.
export function summariseDownloads(ids: string[], tracks: Record<string, OfflineTrack>): DownloadSummary {
  const records = ids.map((id) => tracks[id])
  const done = records.filter((record) => record?.status === 'available-offline')
  const failed = records.filter((record) => record?.status === 'failed')
  const busy = records.some((record) => record?.status === 'queued' || record?.status === 'downloading')
  const bytes = done.reduce((sum, record) => sum + (record?.bytes ?? 0), 0)
  const status: DownloadStatus = !ids.length || records.every((record) => !record) ? 'not-downloaded'
    : busy ? (records.some((record) => record?.status === 'downloading') ? 'downloading' : 'queued')
    : failed.length ? 'failed'
    : done.length === ids.length ? 'available-offline' : 'not-downloaded'
  return { status, total: ids.length, done: done.length, failed: failed.length, bytes, error: failed[0]?.error }
}

// For tests: forget the module's queue between cases.
export function resetDownloadsForTests() {
  active?.controller.abort()
  client = null
  active = null
  pumping = false
  syncing = false
  lastSync = 0
  useDownloads.setState({ supported: offlineSupported(), ready: false, account: null, tracks: {}, collections: {}, progress: {}, persisted: null, notice: null })
}
