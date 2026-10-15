import type { Track } from '../types'

export interface TracklistTrack { key: string; disc: number; number: number; title: string; artist: string | null; length: number | null; recordingId: string | null; isrc?: string | null }
export interface AlbumTracklist {
  albumId: string; releaseId: string; releaseGroupId: string | null; title: string; artist: string | null; date: string | null; country: string | null
  format: string | null; status: string | null; disambiguation: string | null; discCount: number; source: 'tagged' | 'auto' | 'manual'; fetchedAt: string; tracks: TracklistTrack[]
}
export interface ReleaseEdition { id: string; title: string; date: string | null; country: string | null; status: string | null; disambiguation: string | null; format: string | null; trackCount: number; discCount: number }
export interface RecoveryLink { id: string; status: string }
export interface TrackMatch { track: TracklistTrack; local: Track[] }
export interface CompletenessResult { total: number; present: number; complete: boolean; matches: TrackMatch[]; missing: TracklistTrack[]; extras: Track[]; duplicated: number }

const versionSuffix = /\s*(?:-\s+[^-]*\b(?:remaster(?:ed)?|version|mono|stereo|mix|edit)\b[^-]*|[[(][^\])]*\b(?:remaster(?:ed)?|version|mono|stereo|mix|edit)\b[^\])]*[\])])\s*$/i

export function completenessText(value?: string | null) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[\u2019']/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
}

function baseTitle(value?: string | null) {
  let title = String(value || '').trim()
  let previous = ''
  while (title && title !== previous) { previous = title; title = title.replace(versionSuffix, '').trim() }
  return completenessText(title || value)
}

export function titleSimilarity(left?: string | null, right?: string | null) {
  const a = baseTitle(left)
  const b = baseTitle(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const leftTokens = new Set(a.split(' '))
  const rightTokens = new Set(b.split(' '))
  let common = 0
  leftTokens.forEach((token) => { if (rightTokens.has(token)) common += 1 })
  return 2 * common / (leftTokens.size + rightTokens.size)
}

function durationWithin(track: TracklistTrack, local: Track, seconds: number) {
  if (!track.length || !local.duration) return true
  return Math.abs(track.length - local.duration) <= seconds
}

/** Compares a canonical tracklist with every local copy of an album (all editions and recovery copies). */
export function assessAlbumCompleteness(tracklist: Pick<AlbumTracklist, 'tracks'>, localTracks: Track[]): CompletenessResult {
  const matches: TrackMatch[] = tracklist.tracks.map((track) => ({ track, local: [] }))
  let remaining = [...localTracks]
  const assign = (accept: (local: Track) => TrackMatch | undefined) => {
    remaining = remaining.filter((local) => {
      const match = accept(local)
      if (!match) return true
      match.local.push(local)
      return false
    })
  }

  assign((local) => local.musicBrainzId ? matches.find((match) => match.track.recordingId === local.musicBrainzId) : undefined)
  assign((local) => {
    if (!local.track) return undefined
    const match = matches.find((value) => value.track.disc === (local.discNumber || 1) && value.track.number === local.track)
    return match && (titleSimilarity(match.track.title, local.title) >= 0.6 || (titleSimilarity(match.track.title, local.title) >= 0.3 && durationWithin(match.track, local, 3))) ? match : undefined
  })
  assign((local) => matches
    .map((match) => ({ match, score: titleSimilarity(match.track.title, local.title) }))
    .filter(({ match, score }) => score >= 0.85 && durationWithin(match.track, local, 10))
    .sort((left, right) => Number(left.match.local.length > 0) - Number(right.match.local.length > 0) || right.score - left.score)[0]?.match)

  const present = matches.filter((match) => match.local.length > 0).length
  return {
    total: matches.length,
    present,
    complete: matches.length > 0 && present === matches.length,
    matches,
    missing: matches.filter((match) => match.local.length === 0).map((match) => match.track),
    extras: remaining,
    duplicated: matches.filter((match) => match.local.length > 1).length,
  }
}

/** Distinct local recordings, so duplicate master/recovery copies do not inflate the edition hint. */
export function distinctLocalTrackCount(tracks: Track[]) {
  return new Set(tracks.map((track) => `${track.discNumber || 1}:${baseTitle(track.title)}`)).size
}

export function editionLabel(edition: Pick<ReleaseEdition, 'date' | 'country' | 'format' | 'disambiguation'> & { trackCount?: number }) {
  return [edition.date?.slice(0, 4), edition.country, edition.format, edition.trackCount ? `${edition.trackCount} tracks` : null, edition.disambiguation].filter(Boolean).join(' · ')
}
