import type { ReplayGain } from '../shared/replaygain.mjs'
export interface Artist { id: string; name: string; albumCount?: number; coverArt?: string; starred?: string; musicBrainzId?: string }
// OpenSubsonic's per-artist list on songs and albums (Navidrome 0.53+), used to link each artist.
export interface ArtistRef { id: string; name: string }
export type PartialDate = string | { year?: number; month?: number; day?: number }
export interface Album {
  id: string
  name: string
  title?: string
  artist: string
  artistId?: string
  artists?: ArtistRef[]
  coverArt?: string
  year?: number
  songCount?: number
  duration?: number
  created?: string
  played?: string
  starred?: string
  userRating?: number
  musicBrainzId?: string
  releaseTypes?: string[]
  isCompilation?: boolean
  releaseDate?: PartialDate
  originalReleaseDate?: PartialDate
}
export interface Track { id: string; title: string; artist: string; artistId?: string; artists?: ArtistRef[]; album: string; albumId?: string; coverArt?: string; duration?: number; track?: number; discNumber?: number; starred?: string; suffix?: string; size?: number; contentType?: string; musicBrainzId?: string; isrc?: string; replayGain?: ReplayGain; year?: number; genre?: string; playCount?: number; played?: string; created?: string; userRating?: number; bpm?: number; genres?: { name: string }[]; moods?: string[]; bitRate?: number; bitDepth?: number; samplingRate?: number; channelCount?: number; path?: string; comment?: string; contributors?: { role: string; subRole?: string; artist: ArtistRef }[] }
export interface Playlist { id: string; name: string; owner?: string; songCount?: number; duration?: number; coverArt?: string; entry?: Track[] }
export interface SearchResults { artists: Artist[]; albums: Album[]; tracks: Track[] }
export type RepeatMode = 'off' | 'all' | 'one'
export type DownloadStatus = 'not-downloaded' | 'queued' | 'downloading' | 'available-offline' | 'update-available' | 'failed'
export interface PlaybackSource { url: string; kind: 'stream' | 'local'; revoke?: () => void }
export interface TrackSourceResolver { resolve(track: Track): Promise<PlaybackSource> }
