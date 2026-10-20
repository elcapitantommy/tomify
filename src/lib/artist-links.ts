import type { ArtistRef } from '../types'

export type ArtistSegment = { text: string; id?: string }

const valid = (refs: (ArtistRef | null | undefined)[] | undefined) => {
  const seen = new Set<string>()
  return (refs ?? []).filter((ref): ref is ArtistRef => {
    if (!ref?.id || !ref.name?.trim() || seen.has(ref.id)) return false
    seen.add(ref.id)
    return true
  })
}

// Splits an artist line ("Queen & David Bowie", "Calvin Harris feat. Rihanna") into plain text and
// linked parts. Each named artist links where its name appears in the line, so "feat." and "&" stay
// as they were. If no name can be found in the line (a tag spelled differently, for example), the
// whole line links to the main artist. With no artist id at all the line is plain text.
export function artistSegments(text: string | null | undefined, artists?: (ArtistRef | null | undefined)[], artistId?: string | null): ArtistSegment[] {
  const line = text ?? ''
  const refs = valid(artists)
  if (!line.trim()) return refs.length ? refs.flatMap((ref, index) => index ? [{ text: ', ' }, { text: ref.name, id: ref.id }] : [{ text: ref.name, id: ref.id }]) : []
  const lower = line.toLocaleLowerCase()
  const found: { start: number; end: number; id: string }[] = []
  // Longest names first, so "Earth, Wind & Fire" isn't claimed by an artist called "Fire".
  for (const ref of [...refs].sort((a, b) => b.name.length - a.name.length)) {
    const name = ref.name.trim().toLocaleLowerCase()
    for (let from = 0; ;) {
      const start = lower.indexOf(name, from)
      if (start < 0) break
      const end = start + name.length
      if (!found.some((match) => start < match.end && end > match.start)) { found.push({ start, end, id: ref.id }); break }
      from = start + 1
    }
  }
  if (!found.length) {
    const id = artistId || refs[0]?.id
    return [id ? { text: line, id } : { text: line }]
  }
  found.sort((a, b) => a.start - b.start)
  const segments: ArtistSegment[] = []
  let at = 0
  for (const match of found) {
    if (match.start > at) segments.push({ text: line.slice(at, match.start) })
    segments.push({ text: line.slice(match.start, match.end), id: match.id })
    at = match.end
  }
  if (at < line.length) segments.push({ text: line.slice(at) })
  return segments
}
