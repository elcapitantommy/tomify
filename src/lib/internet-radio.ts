// Internet radio: stations are kept in Navidrome (Subsonic internet radio calls; only administrators can
// add or remove them) and found with the free Radio Browser directory (radio-browser.info).
export interface RadioStation { id: string; name: string; streamUrl: string; homePageUrl?: string }
export interface DirectoryStation { id: string; name: string; streamUrl: string; homePageUrl?: string; country?: string; tags: string[]; codec?: string; bitrate?: number; favicon?: string }

const DIRECTORY = 'https://all.api.radio-browser.info/json/stations/search'

// Browsers block plain-http audio on an https page, so only https streams are offered.
export function isSecureStream(url: string) {
  try { return new URL(url).protocol === 'https:' } catch { return false }
}

export function isHlsStream(url: string) {
  try { return /\.m3u8$/i.test(new URL(url).pathname) } catch { return false }
}

interface DirectoryRow { stationuuid?: string; name?: string; url_resolved?: string; url?: string; homepage?: string; country?: string; tags?: string; codec?: string; bitrate?: number; favicon?: string; lastcheckok?: number; clickcount?: number }

export function directoryResults(rows: DirectoryRow[]): DirectoryStation[] {
  const seen = new Set<string>()
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const streamUrl = (row.url_resolved || row.url || '').trim()
    const name = (row.name || '').trim()
    if (!row.stationuuid || !name || !isSecureStream(streamUrl) || row.lastcheckok === 0 || seen.has(streamUrl)) return []
    seen.add(streamUrl)
    return [{ id: row.stationuuid, name, streamUrl, homePageUrl: row.homepage || undefined, country: row.country || undefined, tags: (row.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 4), codec: row.codec || undefined, bitrate: row.bitrate || undefined, favicon: row.favicon && isSecureStream(row.favicon) ? row.favicon : undefined }]
  })
}

// Radio Browser's name filter is a plain substring match, so "Absolute 80s" misses "Absolute Radio 80s".
// Station names are compared as lower-case words with accents and punctuation removed ("80's" = "80s").
export function searchWords(text: string): string[] {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['\u2019]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

export function matchesAllWords(name: string, words: string[]) {
  const haystack = ` ${searchWords(name).join(' ')} `
  return words.every((word) => haystack.includes(word))
}

const RESULT_LIMIT = 40
const WORD_LIMIT = 300
const MAX_WORD_SEARCHES = 3

function directoryUrl(name: string, limit: number) {
  const url = new URL(DIRECTORY)
  url.searchParams.set('name', name)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('order', 'clickcount')
  url.searchParams.set('reverse', 'true')
  url.searchParams.set('hidebroken', 'true')
  return url
}

async function fetchRows(url: URL, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<DirectoryRow[]> {
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error('The radio directory could not be searched.')
  const rows = await response.json()
  return Array.isArray(rows) ? rows : []
}

// One word: a single directory search. Several words: the whole phrase plus each of the longest words
// (up to three) are searched together, and only stations whose name contains every word are kept, so the
// words can be in any order and have other words between them. Exact phrase matches come first, then
// the most played.
export async function searchDirectory(name: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<DirectoryStation[]> {
  const query = name.trim()
  const words = [...new Set(searchWords(query))]
  if (words.length < 2) return directoryResults(await fetchRows(directoryUrl(query, RESULT_LIMIT), signal, fetcher))
  const wordSearches = [...words].sort((a, b) => b.length - a.length).slice(0, MAX_WORD_SEARCHES)
  const settled = await Promise.allSettled([directoryUrl(query, RESULT_LIMIT), ...wordSearches.map((word) => directoryUrl(word, WORD_LIMIT))].map((url) => fetchRows(url, signal, fetcher)))
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const batches = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!batches.length) throw (settled[0] as PromiseRejectedResult).reason
  const byId = new Map<string, DirectoryRow>()
  for (const row of batches.flat()) if (row.stationuuid && !byId.has(row.stationuuid) && matchesAllWords(row.name || '', words)) byId.set(row.stationuuid, row)
  const phrase = ` ${words.join(' ')} `
  const exact = (row: DirectoryRow) => ` ${searchWords(row.name || '').join(' ')} `.includes(phrase) ? 0 : 1
  const rows = [...byId.values()].sort((a, b) => exact(a) - exact(b) || (b.clickcount ?? 0) - (a.clickcount ?? 0))
  return directoryResults(rows).slice(0, RESULT_LIMIT)
}
