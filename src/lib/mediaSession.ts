import type { Track } from '../types'
import type { NavidromeClient } from './navidrome'

export function setMediaMetadata(track: Track, api: NavidromeClient) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.artist, album: track.album,
    artwork: [96, 128, 192, 256, 384, 512].map((size) => ({ src: api.coverArtUrl(track.coverArt ?? track.albumId, size), sizes: `${size}x${size}`, type: 'image/jpeg' })).filter((art) => art.src),
  })
}
