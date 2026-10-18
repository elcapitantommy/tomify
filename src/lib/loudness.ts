import { replayGainDb, type ReplayGainMode } from '../../shared/replaygain.mjs'
import type { NormalisationSetting } from '../stores/normalisation'
import type { Track } from '../types'

// Loudness normalisation from Navidrome's ReplayGain tags. Adaptive streams have the gain baked in
// by the agent (the only way that works on an iPhone); original files are turned down with the audio
// element's volume, which only ever lowers, so a track tagged louder than the reference plays as it is.

/** Album gain while the track sits next to another from its album in the queue, track gain otherwise. */
export function gainModeAt(queue: Track[], index: number, setting: NormalisationSetting): ReplayGainMode | null {
  if (setting === 'off') return null
  if (setting !== 'auto') return setting
  const track = queue[index]
  if (!track?.albumId) return 'track'
  const sameAlbum = (neighbour?: Track) => neighbour?.albumId === track.albumId && neighbour?.id !== track.id
  return sameAlbum(queue[index - 1]) || sameAlbum(queue[index + 1]) ? 'album' : 'track'
}

/** Where `track` is in the queue: the current spot or the next one if it is there, else its first. */
export function queueIndexOf(queue: Track[], currentIndex: number, track: Track) {
  for (const index of [currentIndex, currentIndex + 1]) if (queue[index]?.id === track.id) return index
  return queue.findIndex((candidate) => candidate.id === track.id)
}

/** The mode to ask an adaptive stream for: none for an untagged track, so it shares the untouched stream. */
export function streamGainMode(track: Track, mode: ReplayGainMode | null) {
  return mode && replayGainDb(track.replayGain, mode) !== null ? mode : null
}

/** What to multiply the listener's volume by for an original file: 1 when untagged or off. */
export function originalVolumeScale(track: Track | undefined, mode: ReplayGainMode | null) {
  const gain = mode && track ? replayGainDb(track.replayGain, mode) : null
  if (gain === null) return 1
  return Math.min(1, 10 ** (gain / 20))
}
