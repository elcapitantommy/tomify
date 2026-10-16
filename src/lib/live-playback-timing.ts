import type { LivePlaybackSnapshot } from '../stores/livePlayback'

export const POLL_FAST_MS = 1500
export const POLL_MAX_MS = 10_000
export const PUBLISH_CHECK_MS = 3000
export const KEEP_ALIVE_MS = 30_000
/** Seconds the published position may drift from the extrapolated one before it is republished. */
export const POSITION_DRIFT_S = 2
/** How long another device's snapshot is treated as live: one keep-alive plus a slow poll, with slack. */
export const LIVE_PLAYBACK_FRESH_MS = KEEP_ALIVE_MS + POLL_MAX_MS + 5000

export type PublishableSnapshot = Omit<LivePlaybackSnapshot, 'updatedAt' | 'revision'>

export function nextPollDelay(current: number, changed: boolean) {
  return changed ? POLL_FAST_MS : Math.min(POLL_MAX_MS, current * 2)
}

/** Everything a remote device renders except the position, which it extrapolates. */
export function snapshotSignature(snapshot: PublishableSnapshot) {
  return JSON.stringify([
    snapshot.deviceId,
    snapshot.queue.map((track) => track.id),
    snapshot.currentIndex,
    snapshot.playing,
    Math.round(snapshot.duration),
    snapshot.volume,
    snapshot.muted,
    snapshot.shuffle,
    snapshot.repeat,
  ])
}

export interface PublishedRecord {
  signature: string
  currentTime: number
  playing: boolean
  at: number
}

export function shouldPublish(snapshot: PublishableSnapshot, last: PublishedRecord | null, now: number) {
  if (!last) return true
  if (now - last.at >= KEEP_ALIVE_MS) return true
  if (snapshotSignature(snapshot) !== last.signature) return true
  const expected = last.currentTime + (last.playing ? (now - last.at) / 1000 : 0)
  return Math.abs(snapshot.currentTime - expected) > POSITION_DRIFT_S
}
