import type { Album, Artist } from '../types'
import { useAuth } from '../stores/auth'

export interface NewRelease { id: string; artist: string; title: string; type: 'album' | 'ep' | 'single'; date: string }
export interface NewReleasesResponse { releases: NewRelease[]; artists: number; checked: number }

const SYNC_KEY = 'tomify-new-release-artists'
export const SYNC_EVERY_MS = 24 * 3_600_000

function authHeaders(): Record<string, string> {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to see new releases.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
}

// Same rules as the Worker's artistKey, so "The Beatles" and "Beatles" or "Motley Crue" and "Mötley Crüe" agree.
export function artistKey(name: string) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '')
}

// Edition notes such as "(Deluxe Edition)" or "[Remastered]" don't make a different record.
export function titleKey(title: string) {
  return artistKey(String(title || '').replace(/\s*[([][^)\]]*[)\]]/g, ' ').replace(/^the\s+/i, ''))
}

// Releases already in the library (by artist and title) are not news.
export function notInLibrary(releases: NewRelease[], albums: Pick<Album, 'name' | 'artist'>[]) {
  const owned = new Set(albums.map((album) => `${artistKey(album.artist)}|${titleKey(album.name)}`))
  return releases.filter((release) => !owned.has(`${artistKey(release.artist)}|${titleKey(release.title)}`))
}

export function releaseDateLabel(date: string, now = new Date()) {
  const [year, month, day] = date.split('-').map(Number)
  const when = new Date(year, (month || 1) - 1, day || 1)
  const text = day ? when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: year === now.getFullYear() ? undefined : 'numeric' }) : month ? when.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : String(year)
  const upcoming = day ? when.getTime() > now.getTime() : false
  return upcoming ? `Out ${text}` : text
}

export function coverUrl(id: string) {
  return `https://coverartarchive.org/release-group/${encodeURIComponent(id)}/front-250`
}

function lastSync(username: string) {
  try { return Number(JSON.parse(window.localStorage.getItem(SYNC_KEY) ?? '{}')[username]) || 0 } catch { return 0 }
}
function rememberSync(username: string, at: number) {
  try { const all = JSON.parse(window.localStorage.getItem(SYNC_KEY) ?? '{}'); all[username] = at; window.localStorage.setItem(SYNC_KEY, JSON.stringify(all)) } catch { /* storage unavailable */ }
}

export const newReleasesApi = {
  load: async (signal?: AbortSignal): Promise<NewReleasesResponse> => {
    const response = await fetch('/api/new-releases?days=120', { headers: authHeaders(), signal })
    if (!response.ok) throw new Error('Tomify could not load new releases.')
    return response.json()
  },
  // Tells the Worker which artists are in the library, at most once a day per account on this device.
  syncArtists: async (username: string, loadArtists: () => Promise<Artist[]>, now = Date.now()) => {
    if (now - lastSync(username) < SYNC_EVERY_MS) return false
    const artists = (await loadArtists()).map((artist) => ({ name: artist.name, musicBrainzId: artist.musicBrainzId }))
    if (!artists.length) return false
    const response = await fetch('/api/new-releases/artists', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ artists }) })
    if (!response.ok) return false
    rememberSync(username, now)
    return true
  },
}
