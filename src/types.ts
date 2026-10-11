export interface Artist { id: string; name: string; albumCount?: number; coverArt?: string; starred?: string }
export type PartialDate = string | { year?: number; month?: number; day?: number }
export interface Album {
  id: string
  name: string
  title?: string
  artist: string
  artistId?: string
  coverArt?: string
  year?: number
  songCount?: number
  duration?: number
  created?: string
  starred?: string
  musicBrainzId?: string
  releaseTypes?: string[]
  isCompilation?: boolean
  releaseDate?: PartialDate
  originalReleaseDate?: PartialDate
}
export interface Track { id: string; title: string; artist: string; artistId?: string; album: string; albumId?: string; coverArt?: string; duration?: number; track?: number; discNumber?: number; starred?: string; suffix?: string; contentType?: string }
export interface Playlist { id: string; name: string; songCount?: number; duration?: number; coverArt?: string; entry?: Track[] }
export interface SearchResults { artists: Artist[]; albums: Album[]; tracks: Track[] }
export type RepeatMode = 'off' | 'all' | 'one'
export type DownloadStatus = 'not-downloaded' | 'queued' | 'downloading' | 'available-offline' | 'update-available' | 'failed'
export interface PlaybackSource { url: string; kind: 'stream' | 'local'; revoke?: () => void }
export interface TrackSourceResolver { resolve(track: Track): Promise<PlaybackSource> }
