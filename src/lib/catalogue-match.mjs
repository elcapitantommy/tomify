// Spotify → library track matching, shared by the browser (src/lib/catalogue-import.ts) and the
// Worker build (scripts/catalogue-import.mjs). Plain ES module with no imports so the Worker can
// embed functions from it with fn.toString(). Types live in catalogue-match.d.mts.

export function normaliseCatalogueText(value) {
  return String(value || '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Reissue labels that don't change the recording. Live, remix, acoustic and similar stay, so they still count as differences.
const EDITION = String.raw`(?:(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s+(?:in\s+)?\d{4})?(?:\s+version)?|(?:\d{4}\s+)?(?:super\s+)?deluxe(?:\s+(?:edition|version))?|(?:\d+(?:st|nd|rd|th)\s+)?(?:expanded|anniversary)\s+edition|(?:mono|stereo)(?:\s+(?:version|mix))?|single\s+version)`
const DASH_EDITION = new RegExp(String.raw`\s+[-–—]\s+${EDITION}\s*$`, 'i')
const BRACKET_EDITION = new RegExp(String.raw`\s*[([]\s*${EDITION}\s*[)\]]`, 'gi')
const FEATURING = /\s*(?:[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]|\s+[-–—]\s+(?:feat\.?|ft\.?|featuring)\s+.*$)/gi

export function stripEditionSuffix(value) {
  let text = String(value || '').trim()
  for (let previous = ''; previous !== text;) { previous = text; text = text.replace(BRACKET_EDITION, '').replace(FEATURING, '').replace(DASH_EDITION, '').trim() }
  return text || String(value || '').trim()
}

// "A feat. B" or "A, B" → "A". Spotify usually splits artists already; this covers a single combined credit.
export function primaryArtist(value) {
  return String(value || '').split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim()
}

function catalogueSimilarity(expected, actual) {
  const left = new Set(normaliseCatalogueText(expected).split(' ').filter(Boolean))
  const right = new Set(normaliseCatalogueText(actual).split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function versionSignals(value) {
  const text = normaliseCatalogueText(stripEditionSuffix(value))
  return ['live', 'remix', 'acoustic', 'radio edit', 'karaoke', 'cover', 'sped up', 'slowed', 'instrumental'].filter((signal) => text.includes(signal))
}

function artistSimilarity(artists, candidateArtist) {
  const wanted = (artists || []).filter(Boolean)
  if (!wanted.length) return 0
  const lead = primaryArtist(wanted[0])
  return Math.max(catalogueSimilarity(wanted.join(' '), candidateArtist), catalogueSimilarity(lead, candidateArtist), catalogueSimilarity(lead, primaryArtist(candidateArtist)))
}

export function scoreCatalogueMatch(wanted, candidate) {
  const wantedRecordingId = normaliseCatalogueText(wanted.musicBrainzRecordingId)
  const candidateRecordingId = normaliseCatalogueText(candidate.musicBrainzId || candidate.musicBrainzRecordingId)
  if (wantedRecordingId && candidateRecordingId && wantedRecordingId === candidateRecordingId) return 100
  const wantedIsrc = normaliseCatalogueText(wanted.isrc)
  const candidateIsrc = normaliseCatalogueText(candidate.isrc)
  if (wantedIsrc && candidateIsrc && wantedIsrc === candidateIsrc) return 99
  const wantedVersions = versionSignals(wanted.title)
  const candidateVersions = versionSignals(candidate.title)
  if (wantedVersions.some((signal) => !candidateVersions.includes(signal)) || candidateVersions.some((signal) => !wantedVersions.includes(signal))) return 0
  const title = catalogueSimilarity(stripEditionSuffix(wanted.title), stripEditionSuffix(candidate.title))
  const artist = artistSimilarity(wanted.artists || [wanted.artist], candidate.artist)
  const album = wanted.album ? catalogueSimilarity(stripEditionSuffix(wanted.album), stripEditionSuffix(candidate.album)) : 0.5
  const durationDifference = wanted.duration && candidate.duration ? Math.abs(Number(wanted.duration) - Number(candidate.duration)) : null
  const duration = durationDifference == null ? 0.5 : durationDifference <= 2 ? 1 : durationDifference <= 5 ? 0.8 : durationDifference <= 10 ? 0.35 : 0
  if (title < 0.65 || artist < 0.65) return Math.round((title * 0.55 + artist * 0.35 + duration * 0.1) * 70)
  return Math.round(Math.min(98, title * 43 + artist * 35 + album * 12 + duration * 10))
}

export function matchCatalogueItem(item, candidates) {
  if (item.status === 'unavailable') return item
  const ranked = (Array.isArray(candidates) ? candidates : []).map((track) => ({ track, confidence: scoreCatalogueMatch(item, track) })).filter((entry) => entry.confidence > 0).sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  const best = ranked[0]
  const ambiguous = Boolean(ranked[1] && ranked[1].confidence >= 72 && best && best.confidence - ranked[1].confidence <= 4)
  if (!best || best.confidence < 72) return { ...item, status: 'missing', localTrack: null, matchConfidence: best?.confidence || 0, matchCandidates: ranked }
  if (best.confidence < 92 || ambiguous) return { ...item, status: 'review', localTrack: null, matchConfidence: best.confidence, matchCandidates: ranked }
  return { ...item, status: 'available', localTrack: best.track, localTrackId: best.track.id, matchConfidence: best.confidence, matchCandidates: ranked }
}

// Navidrome's search3 needs every word to match, so search by the lead artist and the bare title, then the title alone.
export function catalogueSearchQueries(item) {
  const title = stripEditionSuffix(item.title)
  const lead = primaryArtist((item.artists || [])[0])
  return [...new Set([lead ? `${lead} ${title}` : title, title])]
}

export async function findCatalogueMatch(item, search) {
  if (item.status === 'unavailable') return item
  const seen = new Map()
  let matched = matchCatalogueItem(item, [])
  for (const query of catalogueSearchQueries(item)) {
    for (const track of await search(query)) if (track?.id && !seen.has(track.id)) seen.set(track.id, track)
    matched = matchCatalogueItem(item, [...seen.values()])
    if (matched.status !== 'missing') return matched
  }
  return matched
}
