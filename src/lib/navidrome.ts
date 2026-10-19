import SparkMD5 from 'spark-md5'
import type { Album, Artist, Playlist, SearchResults, Track } from '../types'
import type { ReplayGainMode } from '../../shared/replaygain.mjs'
import { mediaRoute, startMediaRoute } from './mediaRoute'
import type { Lyrics } from './lyrics'

export type NowPlaying = Track & { username: string; minutesAgo: number; playerName?: string }
export interface ScanStatus { scanning: boolean; count?: number; folderCount?: number; lastScan?: string }
export interface AuthSession { serverUrl: string; username: string; salt: string; token: string }
interface SubsonicEnvelope { 'subsonic-response': Record<string, unknown> & { status: 'ok' | 'failed'; error?: { code: number; message: string } } }

export type StarKind = 'song' | 'album' | 'artist'
const STAR_PARAM: Record<StarKind, string> = { song: 'id', album: 'albumId', artist: 'artistId' }

type SubsonicParams = Record<string, string | number | string[] | number[] | undefined>
function appendParam(target: URLSearchParams, key: string, value: SubsonicParams[string]) {
  if (value === undefined) return
  if (Array.isArray(value)) { target.delete(key); value.forEach((item) => target.append(key, String(item))) }
  else target.set(key, String(value))
}

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
// Web Audio (the equaliser) can only read audio served from the app's own origin; another server's
// streams would play silent through it. The Tomify music server is proxied through the Worker.
export function streamsFromThisOrigin(serverUrl: string) {
  if (typeof window === 'undefined') return false
  try { return new URL(requestServerUrl(serverUrl)).origin === window.location.origin } catch { return false }
}

export function createAuthSession(serverUrl: string, username: string, password: string): AuthSession {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { serverUrl: normaliseServerUrl(serverUrl), username: username.trim(), salt, token: SparkMD5.hash(password + salt) }
}

export function sameAccount(left: string | undefined, right: string | undefined) { return Boolean(left && right) && left!.trim().toLowerCase() === right!.trim().toLowerCase() }

export class NavidromeClient {
  constructor(readonly session: AuthSession, private readonly fetcher: typeof fetch = window.fetch.bind(window)) {}

  url(endpoint: string, params: SubsonicParams = {}) {
    const url = new URL(`${requestServerUrl(this.session.serverUrl)}/rest/${endpoint}.view`)
    const base = { u: this.session.username, t: this.session.token, s: this.session.salt, v: '1.16.1', c: 'Tomify', f: 'json' }
    Object.entries({ ...base, ...params }).forEach(([key, value]) => appendParam(url.searchParams, key, value))
    return url
  }

  // `form` goes in a POST body (OpenSubsonic formPost) so long song lists don't overflow the URL.
  private async get<T>(endpoint: string, params?: SubsonicParams, signal?: AbortSignal, form?: SubsonicParams): Promise<T> {
    let response: Response
    try {
      const body = form ? new URLSearchParams() : undefined
      if (body && form) Object.entries(form).forEach(([key, value]) => appendParam(body, key, value))
      response = await this.fetcher(this.url(endpoint, params), body ? { method: 'POST', body, signal, credentials: 'omit', cache: 'no-store' } : { signal, credentials: 'omit', cache: 'no-store' })
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
  async scanStatus(signal?: AbortSignal): Promise<ScanStatus> { const r = await this.get<{ scanStatus?: ScanStatus }>('getScanStatus', undefined, signal); return r.scanStatus ?? { scanning: false } }
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
  // Editing: Subsonic only lets the owner change a playlist, so callers check ownsPlaylist first.
  async createPlaylist(name: string, songIds: string[] = []): Promise<Playlist> { const r = await this.get<{ playlist?: Playlist }>('createPlaylist', { name }, undefined, songIds.length ? { songId: songIds } : undefined); if (!r.playlist?.id) throw new NavidromeError('The music server did not return the new playlist.'); return r.playlist }
  async renamePlaylist(id: string, name: string) { await this.get('updatePlaylist', { playlistId: id, name }) }
  async addToPlaylist(id: string, songIds: string[]) { if (songIds.length) await this.get('updatePlaylist', { playlistId: id }, undefined, { songIdToAdd: songIds }) }
  async removeFromPlaylist(id: string, indexes: number[]) { if (indexes.length) await this.get('updatePlaylist', { playlistId: id, songIndexToRemove: indexes }) }
  // createPlaylist with an existing playlistId replaces its whole track list, which is how Subsonic reorders.
  async replacePlaylistTracks(id: string, songIds: string[]) { await this.get('createPlaylist', { playlistId: id }, undefined, { songId: songIds }) }
  async deletePlaylist(id: string) { await this.get('deletePlaylist', { id }) }
  ownsPlaylist(playlist: Pick<Playlist, 'owner'>) { return sameAccount(playlist.owner, this.session.username) }
  // Every song in the library, a page at a time (Navidrome returns everything for an empty search).
  async allSongs(signal?: AbortSignal, onPage?: (loaded: number) => void): Promise<Track[]> { const songs: Track[] = []; for (let offset = 0; ; offset += 500) { const r = await this.get<{ searchResult3?: { song?: Track[] } }>('search3', { query: '', artistCount: 0, albumCount: 0, songCount: 500, songOffset: offset }, signal); const page = r.searchResult3?.song ?? []; songs.push(...page); onPage?.(songs.length); if (page.length < 500) return songs } }
  // Songs by artists like this one, from Navidrome's Last.fm, ListenBrainz or Deezer agents (empty without them).
  async similarSongs(artistId: string, count = 50, signal?: AbortSignal): Promise<Track[]> { const r = await this.get<{ similarSongs2?: { song?: Track[] } }>('getSimilarSongs2', { id: artistId, count }, signal); return r.similarSongs2?.song ?? [] }
  // OpenSubsonic: lyrics from the file's tags or an .lrc file beside it; synced ones are preferred. Times are in ms.
  async lyrics(id: string, signal?: AbortSignal): Promise<Lyrics | null> {
    const r = await this.get<{ lyricsList?: { structuredLyrics?: { synced?: boolean; offset?: number; line?: { start?: number; value?: string }[] }[] } }>('getLyricsBySongId', { id }, signal)
    const all = (r.lyricsList?.structuredLyrics ?? []).filter((item) => item.line?.length)
    const best = all.find((item) => item.synced) ?? all[0]
    if (!best) return null
    const synced = best.synced === true
    return { synced, lines: best.line!.map((line) => ({ time: synced ? Math.max(0, ((line.start ?? 0) - (best.offset ?? 0)) / 1000) : -1, text: (line.value ?? '').trim() })) }
  }
  async genres(signal?: AbortSignal): Promise<string[]> { const r = await this.get<{ genres?: { genre?: { value: string }[] } }>('getGenres', {}, signal); return (r.genres?.genre ?? []).map((genre) => genre.value).filter(Boolean).sort((a, b) => a.localeCompare(b)) }
  // What every account is playing now: Navidrome records it from the "now playing" scrobble each player sends.
  async nowPlaying(signal?: AbortSignal): Promise<NowPlaying[]> { const r = await this.get<{ nowPlaying?: { entry?: NowPlaying[] } }>('getNowPlaying', {}, signal); return r.nowPlaying?.entry ?? [] }
  async starred(signal?: AbortSignal): Promise<SearchResults> { const r = await this.get<{ starred2?: { artist?: Artist[]; album?: Album[]; song?: Track[] } }>('getStarred2', {}, signal); const s = r.starred2; return { artists: s?.artist ?? [], albums: s?.album ?? [], tracks: s?.song ?? [] } }
  // Subsonic stars songs by `id`, albums by `albumId` and artists by `artistId`.
  async star(id: string, kind: StarKind = 'song') { await this.get('star', { [STAR_PARAM[kind]]: id }) }
  async unstar(id: string, kind: StarKind = 'song') { await this.get('unstar', { [STAR_PARAM[kind]]: id }) }
  async scrobble(id: string, submission = true) { await this.get('scrobble', { id, submission: submission ? 'true' : 'false' }); return true }
  coverArtUrl(id?: string, size = 600) { return id ? this.url('getCoverArt', { id, size }).toString() : '' }
  streamUrl(id: string) {
    const params = { id, estimateContentLength: 'true' }
    return (this.mediaUrl('/navidrome/rest/stream.view', { ...params, v: '1.16.1', c: 'Tomify' }) ?? this.url('stream', params)).toString()
  }
  streamsSameOrigin() { return streamsFromThisOrigin(this.session.serverUrl) }
  // The Tomify music server sits behind the Tomify Worker, which adds adaptive streaming and media sessions.
  private viaTomify() { return typeof window !== 'undefined' && normaliseServerUrl(this.session.serverUrl) === DEFAULT_NAVIDROME_SERVER }
  // With a media session (lib/mediaRoute.ts) a stream URL carries a short-lived token instead of the
  // login, and points at the box itself when it answers on the home network.
  private mediaUrl(path: string, params: Record<string, string> = {}) {
    const route = this.viaTomify() ? mediaRoute(this.session.username) : null
    if (!route) return null
    const url = new URL(path, route.origin ?? window.location.origin)
    Object.entries({ ...params, mt: route.token }).forEach(([key, value]) => url.searchParams.set(key, value))
    return url
  }
  startMediaSessions() { return this.viaTomify() ? startMediaRoute(this.session, this.fetcher) : () => {} }
  // Adaptive streaming goes through the Tomify Worker, so it only exists for the Tomify music server.
  // `gain` asks for the stream with that ReplayGain baked in.
  hlsUrl(id: string, gain: ReplayGainMode | null = null) {
    if (!this.viaTomify()) return null
    const path = `/api/hls/${encodeURIComponent(id)}/${gain ? `${gain}/` : ''}master.m3u8`
    const media = this.mediaUrl(path)
    if (media) return media.toString()
    const url = new URL(path, window.location.origin)
    url.searchParams.set('u', this.session.username)
    url.searchParams.set('t', this.session.token)
    url.searchParams.set('s', this.session.salt)
    return url.toString()
  }
}
