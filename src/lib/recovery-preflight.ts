import type { RecoveryCandidate } from './recovery'

export type RecoveryPreflightMode = 'release' | 'track'

export interface RecoveryPreflightTrack {
  title: string
  trackNumber: number | null
  discNumber: number | null
  recordingId: string | null
  tier: string
  path: string | null
}

export interface RecoveryPreflightLibraryMatch {
  kind: 'album' | 'song'
  id: string
  title: string
  artist: string | null
  album?: string | null
  songCount?: number | null
  path?: string | null
}

/** `null` on either side means it could not be checked (an older recovery agent, or Navidrome unreachable). */
export interface RecoveryPreflight {
  target: { artist: string; album: string; title: string; mode: RecoveryPreflightMode }
  directory: string | null
  recovery: RecoveryPreflightTrack[] | null
  library: RecoveryPreflightLibraryMatch[] | null
}

/** A release download imports a whole album; everything else imports one track. */
export function preflightMode(candidate: RecoveryCandidate | undefined): RecoveryPreflightMode {
  const raw = candidate?.provenance?.raw as { searchMode?: unknown } | null | undefined
  return (raw?.searchMode ?? candidate?.provenance?.searchMode) === 'release' ? 'release' : 'track'
}

/** e.g. "1 track already in recovery, Flood is already in your library (12 tracks)", or null when nothing matched. */
export function preflightWarning(preflight: RecoveryPreflight | null) {
  if (!preflight) return null
  const parts: string[] = []
  const inRecovery = preflight.recovery?.length ?? 0
  if (inRecovery) parts.push(`${inRecovery} ${inRecovery === 1 ? 'track' : 'tracks'} already in recovery`)
  const found = preflight.library?.[0]
  if (found) {
    const count = found.kind === 'album' && found.songCount ? ` (${found.songCount} ${found.songCount === 1 ? 'track' : 'tracks'})` : ''
    parts.push(`${found.title} is already in your library${count}`)
  }
  return parts.length ? parts.join(', ') : null
}
