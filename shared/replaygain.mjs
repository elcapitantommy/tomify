// ReplayGain maths shared by the recovery agent (recovery-agent/hls.mjs bakes the gain into adaptive
// streams) and the frontend (src/lib/loudness.ts scales original streams). Navidrome reports the tags
// as the OpenSubsonic `replayGain` object on every song; it never measures loudness itself, so an
// untagged file has no gain and plays untouched.

/** Gain modes a stream can be normalised with. */
export function replayGainModes() {
  return ['track', 'album']
}

export function isReplayGainMode(value) {
  return replayGainModes().includes(value)
}

// Normalised audio keeps its peaks at least this far below full scale, so a boost never clips.
export const REPLAYGAIN_HEADROOM_DB = 1

const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * The gain in dB to apply for `mode`, or null when the track has no usable tag. Album mode falls back
 * to track gain (a single, or a file tagged track by track) and track mode to album gain. The result
 * is capped so the louder peak stays REPLAYGAIN_HEADROOM_DB below full scale.
 */
export function replayGainDb(replayGain, mode) {
  if (!replayGain || typeof replayGain !== 'object' || !isReplayGainMode(mode)) return null
  const track = { gain: finite(replayGain.trackGain), peak: finite(replayGain.trackPeak) }
  const album = { gain: finite(replayGain.albumGain), peak: finite(replayGain.albumPeak) }
  const chosen = mode === 'album' ? (album.gain !== null ? album : track) : (track.gain !== null ? track : album)
  if (chosen.gain === null) return null
  const peak = chosen.peak ?? (chosen === album ? track.peak : album.peak)
  const ceiling = peak && peak > 0 ? -REPLAYGAIN_HEADROOM_DB - 20 * Math.log10(peak) : Infinity
  const gain = Math.min(chosen.gain, ceiling)
  return Math.round(gain * 100) / 100
}
