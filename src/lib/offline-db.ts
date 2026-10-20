// Offline downloads live in IndexedDB, one database per account on this device:
// `tracks` holds each downloaded song's metadata and status, `collections` the albums and
// playlists downloaded whole, and `files` the audio (`audio:<songId>`) and artwork (`art:<coverArtId>`).
// A song is kept while anything owns it: a single-track download (`track`) or a collection (`album:<id>`, `playlist:<id>`).
import { normaliseServerUrl, type AuthSession } from './navidrome'
import type { DownloadStatus, Track } from '../types'
import type { DownloadQuality } from '../stores/downloadQuality'

export type OfflineStatus = Extract<DownloadStatus, 'queued' | 'downloading' | 'available-offline' | 'failed'>
// `quality` is what the song is (or will be) saved as; records from before download qualities are originals.
export interface OfflineTrack { id: string; track: Track; status: OfflineStatus; owners: string[]; quality?: DownloadQuality; bytes?: number; error?: string; addedAt: number; updatedAt: number }
export type CollectionKind = 'album' | 'playlist'
// `owner` is the playlist's owner, so a playlist shared with this account can be checked for changes later.
export interface OfflineCollection { key: string; kind: CollectionKind; id: string; name: string; artist?: string; owner?: string; coverArt?: string; trackIds: string[]; addedAt: number; updatedAt: number }
interface OfflineFile { key: string; blob: Blob }

type StoreName = 'tracks' | 'collections' | 'files'
const DB_VERSION = 1

export const TRACK_OWNER = 'track'
export const collectionKey = (kind: CollectionKind, id: string) => `${kind}:${id}`
export const audioKey = (id: string) => `audio:${id}`
export const artKey = (coverArt: string) => `art:${coverArt}`

export function offlineSupported() { return typeof indexedDB !== 'undefined' }
export function offlineAccount(session: Pick<AuthSession, 'serverUrl' | 'username'>) { return `${normaliseServerUrl(session.serverUrl)}|${session.username.trim().toLowerCase()}` }

// Safari reports a full disk as QuotaExceededError on the request or the transaction; older engines use code 22.
export function isQuotaError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { name, code, message } = error as { name?: string; code?: number; message?: string }
  return name === 'QuotaExceededError' || code === 22 || /quota/i.test(message ?? '')
}

const databases = new Map<string, Promise<IDBDatabase>>()
function openDb(account: string) {
  let opening = databases.get(account)
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`tomify-offline:${account}`, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); databases.delete(account) }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('Offline storage could not be opened.'))
  })
  opening.catch(() => databases.delete(account))
  databases.set(account, opening)
  return opening
}

// One transaction: resolves with the last request's result once everything is written, so a
// quota failure that aborts the transaction rejects instead of looking like a success.
async function transact<T>(account: string, stores: StoreName[], mode: IDBTransactionMode, work: (store: (name: StoreName) => IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb(account)
  return new Promise<T | undefined>((resolve, reject) => {
    let request: IDBRequest<T> | void = undefined
    const tx = db.transaction(stores, mode)
    tx.oncomplete = () => resolve(request ? request.result : undefined)
    tx.onerror = tx.onabort = () => reject(tx.error ?? (request ? request.error : null) ?? new DOMException('The offline storage write failed.', 'AbortError'))
    try { request = work((name) => tx.objectStore(name)) } catch (error) { try { tx.abort() } catch { /* already finished */ } reject(error) }
  })
}

export async function readLibrary(account: string) {
  const tracks = await transact<OfflineTrack[]>(account, ['tracks'], 'readonly', (store) => store('tracks').getAll()) ?? []
  const collections = await transact<OfflineCollection[]>(account, ['collections'], 'readonly', (store) => store('collections').getAll()) ?? []
  return { tracks, collections }
}
export function saveTracks(account: string, records: OfflineTrack[]) { return transact(account, ['tracks'], 'readwrite', (store) => { records.forEach((record) => store('tracks').put(record)) }) }
export function saveCollection(account: string, collection: OfflineCollection) { return transact(account, ['collections'], 'readwrite', (store) => { store('collections').put(collection) }) }
export function deleteCollection(account: string, key: string) { return transact(account, ['collections'], 'readwrite', (store) => { store('collections').delete(key) }) }
// Removes songs with their audio in one go, so no audio is left behind without its record.
export function deleteTracks(account: string, ids: string[], fileKeys: string[] = []) {
  return transact(account, ['tracks', 'files'], 'readwrite', (store) => {
    ids.forEach((id) => { store('tracks').delete(id); store('files').delete(audioKey(id)) })
    fileKeys.forEach((key) => store('files').delete(key))
  })
}
// The audio and the record that marks it available are written together.
export function storeDownload(account: string, record: OfflineTrack, audio: Blob, artwork?: { key: string; blob: Blob }) {
  return transact(account, ['tracks', 'files'], 'readwrite', (store) => {
    store('files').put({ key: audioKey(record.id), blob: audio } satisfies OfflineFile)
    if (artwork) store('files').put({ key: artwork.key, blob: artwork.blob } satisfies OfflineFile)
    store('tracks').put(record)
  })
}
export function storeFile(account: string, key: string, blob: Blob) { return transact(account, ['files'], 'readwrite', (store) => { store('files').put({ key, blob } satisfies OfflineFile) }) }
export async function readFile(account: string, key: string) { return (await transact<OfflineFile | undefined>(account, ['files'], 'readonly', (store) => store('files').get(key)))?.blob }
export async function readTrack(account: string, id: string) { return transact<OfflineTrack | undefined>(account, ['tracks'], 'readonly', (store) => store('tracks').get(id)) }

// Object URLs for downloaded audio, made once a song is first played and kept until it is removed.
// The player looks them up synchronously when it picks a source, so a reload or the next song
// in the queue plays the local copy too, not only the first load.
const audioUrls = new Map<string, string>()
const urlKey = (account: string, id: string) => `${account}\n${id}`

export function cachedLocalAudioUrl(session: Pick<AuthSession, 'serverUrl' | 'username'>, id: string) { return audioUrls.get(urlKey(offlineAccount(session), id)) }

// A copy is valid when its record says it finished and the stored audio is the size that was downloaded.
export async function localAudioUrl(session: Pick<AuthSession, 'serverUrl' | 'username'>, id: string): Promise<string | undefined> {
  if (!offlineSupported()) return undefined
  const account = offlineAccount(session)
  const cached = audioUrls.get(urlKey(account, id))
  if (cached) return cached
  try {
    const record = await readTrack(account, id)
    if (record?.status !== 'available-offline') return undefined
    const blob = await readFile(account, audioKey(id))
    if (!blob || blob.size === 0 || (record.bytes !== undefined && blob.size !== record.bytes)) return undefined
    const url = URL.createObjectURL(blob)
    audioUrls.set(urlKey(account, id), url)
    return url
  } catch {
    return undefined
  }
}

export function forgetLocalAudio(account: string, ids: string[]) {
  ids.forEach((id) => {
    const url = audioUrls.get(urlKey(account, id))
    if (!url) return
    audioUrls.delete(urlKey(account, id))
    URL.revokeObjectURL(url)
  })
}

// Tests start each case with empty databases.
export function resetOfflineDbForTests() { databases.clear(); audioUrls.clear() }
