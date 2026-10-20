import type { Artist } from '../types'

export interface ArtistInfo { biography: string[]; lastFmUrl?: string; musicBrainzId?: string; largeImageUrl?: string; similar: Artist[] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

// Navidrome passes on Last.fm's biography as HTML ending in a "Read more on Last.fm" link and a
// licence line. Tomify shows it as plain paragraphs without those.
export function cleanBiography(html: string | undefined): string[] {
  if (!html) return []
  const text = decodeEntities(html
    .replace(/<a\b[^>]*>\s*Read more on Last\.fm\s*<\/a>\.?/gi, '')
    .replace(/User-contributed text is available under the Creative Commons[^]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ''))
  return text.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

export function parseArtistInfo(raw: { biography?: string; lastFmUrl?: string; musicBrainzId?: string; largeImageUrl?: string; similarArtist?: Artist[] } | undefined, artistId: string): ArtistInfo {
  return {
    biography: cleanBiography(raw?.biography),
    lastFmUrl: raw?.lastFmUrl || undefined,
    musicBrainzId: raw?.musicBrainzId || undefined,
    largeImageUrl: raw?.largeImageUrl || undefined,
    // includeNotPresent=false already limits this to artists in the library; never list the artist itself.
    similar: (raw?.similarArtist ?? []).filter((artist) => artist.id && artist.id !== artistId),
  }
}
