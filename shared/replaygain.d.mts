export type ReplayGainMode = 'track' | 'album'

/** OpenSubsonic `replayGain` on a song: gains in dB, peaks as linear sample values (1 = full scale). */
export interface ReplayGain {
  trackGain?: number
  albumGain?: number
  trackPeak?: number
  albumPeak?: number
  baseGain?: number
  fallbackGain?: number
}

export function replayGainModes(): ReplayGainMode[]
export function isReplayGainMode(value: unknown): value is ReplayGainMode
export const REPLAYGAIN_HEADROOM_DB: number
export function replayGainDb(replayGain: ReplayGain | null | undefined, mode: ReplayGainMode | string): number | null
