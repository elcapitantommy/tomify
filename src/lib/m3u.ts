// M3U playlist files: written for other players (VLC, foobar2000, Plexamp, a car stick) and read back in.
// Export uses each song's path inside the music folder when Navidrome gives one, so a player pointed at
// the same folder finds the files. Import reads #EXTINF lines, or guesses from the file path, and the
// songs are then matched against the library like a Spotify import (lib/catalogue-match.mjs).
import type { Track } from '../types'

export interface M3uEntry { title: string; artists: string[]; album?: string; duration?: number; path?: string }
export interface M3uPlaylist { name?: string; entries: M3uEntry[] }

const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

function fallbackPath(track: Track) {
  const safe = (value: string) => value.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Unknown'
  const number = track.track ? `${String(track.track).padStart(2, '0')} - ` : ''
  return `${safe(track.artist || 'Unknown artist')}/${safe(track.album || 'Unknown album')}/${number}${safe(track.title)}.${track.suffix || 'mp3'}`
}

export function buildM3u(name: string, tracks: Track[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${clean(name)}`]
  for (const track of tracks) {
    lines.push(`#EXTINF:${Math.round(track.duration ?? -1)},${clean(track.artist || 'Unknown artist')} - ${clean(track.title)}`)
    if (track.album) lines.push(`#EXTALB:${clean(track.album)}`)
    lines.push(track.path ? track.path.replace(/\\/g, '/') : fallbackPath(track))
  }
  return `${lines.join('\n')}\n`
}

export function m3uFileName(name: string) {
  return `${name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Playlist'}.m3u8`
}

// "01 - Song", "01. Song", "1-03 Song" → "Song"
const stripTrackNumber = (value: string) => value.replace(/^\s*(?:\d{1,2}[-.])?\d{1,3}\s*(?:[-._)]\s*|\s+)/, '').trim() || value.trim()

function decodePath(value: string) {
  let path = value.trim()
  if (/^file:/i.test(path)) { try { path = decodeURIComponent(path.replace(/^file:\/*/i, '/')) } catch { /* keep it as written */ } }
  return path.replace(/\\/g, '/')
}

// What a bare path says: Artist/Album/01 - Title.flac, or "Artist - Title.mp3" on its own.
export function entryFromPath(rawPath: string): M3uEntry {
  const path = decodePath(rawPath)
  const parts = path.split('/').filter(Boolean)
  const file = (parts.pop() ?? path).replace(/\.[a-z0-9]{2,5}$/i, '')
  const album = parts.length >= 2 ? parts[parts.length - 1] : undefined
  const folderArtist = parts.length >= 2 ? parts[parts.length - 2] : undefined
  const bare = stripTrackNumber(file)
  const numbered = bare !== file.trim()
  const split = bare.match(/^(.+?)\s+-\s+(.+)$/)
  const sameArtist = Boolean(split && folderArtist && split[1].trim().toLocaleLowerCase('en') === folderArtist.toLocaleLowerCase('en'))
  if (split && sameArtist) return { title: split[2].trim(), artists: [folderArtist!], album, path }
  // "Artist - Title.mp3" names the artist; after a track number ("03 - Title - Live") the folders do.
  if (split && (!folderArtist || !numbered)) return { title: split[2].trim(), artists: [split[1].trim()], path }
  return { title: bare, artists: folderArtist ? [folderArtist] : [], album, path }
}

export function parseM3u(text: string): M3uPlaylist {
  const playlist: M3uPlaylist = { entries: [] }
  let info: { title?: string; artist?: string; duration?: number } | null = null
  let album: string | undefined
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const playlistName = line.match(/^#PLAYLIST:(.*)$/i)
      if (playlistName) { playlist.name = playlistName[1].trim() || undefined; continue }
      const extinf = line.match(/^#EXTINF:\s*(-?[\d.]+)[^,]*,(.*)$/i)
      if (extinf) {
        const duration = Number(extinf[1])
        const display = extinf[2].trim()
        const split = display.match(/^(.+?)\s+-\s+(.+)$/)
        info = { duration: duration > 0 ? Math.round(duration) : undefined, artist: split?.[1].trim(), title: (split?.[2] ?? display).trim() || undefined }
        continue
      }
      const extalb = line.match(/^#EXTALB:(.*)$/i)
      if (extalb) album = extalb[1].trim() || undefined
      continue
    }
    // Streams (internet radio and the like) aren't songs in the library.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^file:/i.test(line)) { info = null; album = undefined; continue }
    const fromPath = entryFromPath(line)
    playlist.entries.push({
      title: info?.title || fromPath.title,
      artists: info?.artist ? [info.artist] : fromPath.artists,
      album: album ?? fromPath.album,
      duration: info?.duration,
      path: fromPath.path,
    })
    info = null
    album = undefined
  }
  return playlist
}

export function downloadM3u(name: string, tracks: Track[]) {
  const blob = new Blob([buildM3u(name, tracks)], { type: 'audio/x-mpegurl;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = m3uFileName(name)
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
