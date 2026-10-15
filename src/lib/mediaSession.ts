import type { Track } from '../types'
import type { NavidromeClient } from './navidrome'
import { albumArtworkUrl, useAlbumArtwork } from '../stores/albumArtwork'

export function setMediaMetadata(track: Track, api: NavidromeClient) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  const override = track.albumId ? useAlbumArtwork.getState().overrides[track.albumId] : undefined
  const replacement = albumArtworkUrl(override)
  const library = [96, 128, 192, 256, 384, 512].map((size) => ({ src: api.coverArtUrl(track.coverArt ?? track.albumId, size), sizes: `${size}x${size}`, type: 'image/jpeg' })).filter((art) => art.src)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.artist, album: track.album,
    artwork: replacement ? [{ src: replacement, sizes: `${override?.width || 640}x${override?.height || 640}`, type: 'image/jpeg' }, ...library] : library,
  })
}
