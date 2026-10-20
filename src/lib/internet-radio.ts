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

interface DirectoryRow { stationuuid?: string; name?: string; url_resolved?: string; url?: string; homepage?: string; country?: string; tags?: string; codec?: string; bitrate?: number; favicon?: string; lastcheckok?: number }

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

export async function searchDirectory(name: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<DirectoryStation[]> {
  const url = new URL(DIRECTORY)
  url.searchParams.set('name', name)
  url.searchParams.set('limit', '40')
  url.searchParams.set('order', 'clickcount')
  url.searchParams.set('reverse', 'true')
  url.searchParams.set('hidebroken', 'true')
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error('The radio directory could not be searched.')
  return directoryResults(await response.json())
}
