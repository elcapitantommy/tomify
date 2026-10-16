import SparkMD5 from 'spark-md5'
import type { Album, Artist, Playlist, SearchResults, Track } from '../types'

export interface ScanStatus { scanning: boolean; count?: number; folderCount?: number; lastScan?: string }
export interface AuthSession { serverUrl: string; username: string; salt: string; token: string }
interface SubsonicEnvelope { 'subsonic-response': Record<string, unknown> & { status: 'ok' | 'failed'; error?: { code: number; message: string } } }

export type StarKind = 'song' | 'album' | 'artist'
const STAR_PARAM: Record<StarKind, string> = { song: 'id', album: 'albumId', artist: 'artistId' }

export class NavidromeError extends Error { constructor(message: string, readonly code?: number) { super(message); this.name = 'NavidromeError' } }

export const DEFAULT_NAVIDROME_SERVER = 'https://tomify.tomdixon.uk'

export function normaliseServerUrl(value: string) {
  const normalised = value.trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined' && normalised === `${window.location.origin}/navidrome`) return DEFAULT_NAVIDROME_SERVER
  return normalised
}

function requestServerUrl(serverUrl: string) {
  const normalised = normaliseServerUrl(serverUrl)
  if (typeof window !== 'undefined' && normalised === DEFAULT_NAVIDROME_SERVER) return `${window.location.origin}/navidrome`
  return normalised
}
export function createAuthSession(serverUrl: string, username: string, password: string): AuthSession {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { serverUrl: normaliseServerUrl(serverUrl), username: username.trim(), salt, token: SparkMD5.hash(password + salt) }
}

export function sameAccount(left: string | undefined, right: string | undefined) { return Boolean(left && right) && left!.trim().toLowerCase() === right!.trim().toLowerCase() }

export class NavidromeClient {
  constructor(readonly session: AuthSession, private readonly fetcher: typeof fetch = window.fetch.bind(window)) {}

  url(endpoint: string, params: Record<string, string | number | undefined> = {}) {
    const url = new URL(`${requestServerUrl(this.session.serverUrl)}/rest/${endpoint}.view`)
    const base = { u: this.session.username, t: this.session.token, s: this.session.salt, v: '1.16.1', c: 'Tomify', f: 'json' }
    Object.entries({ ...base, ...params }).forEach(([key, value]) => value !== undefined && url.searchParams.set(key, String(value)))
    return url
  }

  private async get<T>(endpoint: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(this.url(endpoint, params), { signal, credentials: 'omit' })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      console.error('Navidrome request failed', {
        endpoint,
        serverUrl: this.session.serverUrl,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw new NavidromeError('Tomify cannot reach the music server.')
    }
    if (!response.ok) throw new NavidromeError(`The music server returned ${response.status}.`, response.status)
    const body = await response.json() as SubsonicEnvelope
    const data = body['subsonic-response']
    if (!data || data.status !== 'ok') throw new NavidromeError(data?.error?.message ?? 'The music server rejected the request.', data?.error?.code)
    return data as T
  }

  async ping() { await this.get('ping'); return true }
  async isAdmin() { const r = await this.get<{ user?: { adminRole?: boolean } }>('getUser', { username: this.session.username }); return r.user?.adminRole === true }
  // Navidrome only lets administrators start a scan; fullScan rescans every file instead of only changed folders.
  async startScan(fullScan = true): Promise<ScanStatus> { const r = await this.get<{ scanStatus?: ScanStatus }>('startScan', { fullScan: fullScan ? 'true' : undefined }); return r.scanStatus ?? { scanning: true } }
  async scanStatus(): Promise<ScanStatus> { const r = await this.get<{ scanStatus?: ScanStatus }>('getScanStatus'); return r.scanStatus ?? { scanning: false } }
  async artists(signal?: AbortSignal): Promise<Artist[]> { const r = await this.get<{ artists?: { index?: { artist?: Artist[] }[] } }>('getArtists', {}, signal); return r.artists?.index?.flatMap((i) => i.artist ?? []) ?? [] }
  async artist(id: string, signal?: AbortSignal): Promise<{ artist: Artist & { album?: Album[] } }> { return this.get('getArtist', { id }, signal) }
  async albums(type: 'alphabeticalByName' | 'newest' | 'recent' | 'starred' = 'alphabeticalByName', size = 100, signal?: AbortSignal): Promise<Album[]> { const r = await this.get<{ albumList2?: { album?: Album[] } }>('getAlbumList2', { type, size }, signal); return r.albumList2?.album ?? [] }
  async allAlbums(signal?: AbortSignal): Promise<Album[]> { const albums: Album[] = []; for (let offset = 0; ; offset += 500) { const r = await this.get<{ albumList2?: { album?: Album[] } }>('getAlbumList2', { type: 'alphabeticalByName', size: 500, offset }, signal); const page = r.albumList2?.album ?? []; albums.push(...page); if (page.length < 500) return albums } }
  async album(id: string, signal?: AbortSignal): Promise<Album & { song?: Track[] }> { const r = await this.get<{ album: Album & { song?: Track[] } }>('getAlbum', { id }, signal); return r.album }
  async song(id: string, signal?: AbortSignal): Promise<Track> { const r = await this.get<{ song: Track }>('getSong', { id }, signal); return r.song }
  async search(query: string, signal?: AbortSignal): Promise<SearchResults> { const r = await this.get<{ searchResult3?: { artist?: Artist[]; album?: Album[]; song?: Track[] } }>('search3', { query, artistCount: 20, albumCount: 20, songCount: 50 }, signal); const s = r.searchResult3; return { artists: s?.artist ?? [], albums: s?.album ?? [], tracks: s?.song ?? [] } }
  // Navidrome returns every user's playlists to admins and other users' public playlists to everyone; Tomify only lists the signed-in account's own.
  // Playlists other accounts shared through Tomify are opened with `sharedBy`, the owner named on the share.
  async playlists(signal?: AbortSignal): Promise<Playlist[]> { const r = await this.get<{ playlists?: { playlist?: Playlist[] } }>('getPlaylists', {}, signal); return (r.playlists?.playlist ?? []).filter((playlist) => this.ownsPlaylist(playlist)) }
  async playlist(id: string, signal?: AbortSignal, sharedBy?: string): Promise<Playlist> { const r = await this.get<{ playlist: Playlist }>('getPlaylist', { id }, signal); if (!this.ownsPlaylist(r.playlist) && !(sharedBy && sameAccount(r.playlist.owner, sharedBy))) throw new NavidromeError('Playlist not found.', 70); return r.playlist }
  // Sharing needs the playlist public in Navidrome so recipients' own credentials can read it.
  async setPlaylistPublic(id: string, isPublic: boolean) { await this.get('updatePlaylist', { playlistId: id, public: String(isPublic) }) }
  ownsPlaylist(playlist: Pick<Playlist, 'owner'>) { return sameAccount(playlist.owner, this.session.username) }
  async starred(signal?: AbortSignal): Promise<SearchResults> { const r = await this.get<{ starred2?: { artist?: Artist[]; album?: Album[]; song?: Track[] } }>('getStarred2', {}, signal); const s = r.starred2; return { artists: s?.artist ?? [], albums: s?.album ?? [], tracks: s?.song ?? [] } }
  // Subsonic stars songs by `id`, albums by `albumId` and artists by `artistId`.
  async star(id: string, kind: StarKind = 'song') { await this.get('star', { [STAR_PARAM[kind]]: id }) }
  async unstar(id: string, kind: StarKind = 'song') { await this.get('unstar', { [STAR_PARAM[kind]]: id }) }
  async scrobble(id: string, submission = true) { await this.get('scrobble', { id, submission: submission ? 'true' : 'false' }); return true }
  coverArtUrl(id?: string, size = 600) { return id ? this.url('getCoverArt', { id, size }).toString() : '' }
  streamUrl(id: string) { return this.url('stream', { id, estimateContentLength: 'true' }).toString() }
}
