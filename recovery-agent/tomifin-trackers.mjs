// Find more trackers for a torrent already in Tomifin: from public tracker lists (ngosang's trackerslist and
// newTrackon by default) and from the magnets that Tomifin's own torrent sources (qBittorrent's search plugins and any
// Prowlarr or Jackett indexers) list for the same info hash. tomifin.mjs adds the new ones to the torrent in
// qBittorrent. Nothing is ever added to a private torrent: its private tracker would see that as cheating.
import { isIP } from 'node:net'
import { unsafeAddress } from './tomifin-links.mjs'

export const DEFAULT_TRACKER_LISTS = Object.freeze([
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  'https://newtrackon.com/api/stable',
])
const LIST_TTL_MS = 6 * 60 * 60_000
const MAX_LIST_BYTES = 256 * 1024
const MAX_FROM_LIST = 40
// The most trackers one press adds, from both sources together.
export const MAX_NEW_TRACKERS = 60
const MAX_TRACKER_LENGTH = 300
const TRACKER_PROTOCOLS = new Set(['udp:', 'http:', 'https:', 'ws:', 'wss:'])

function text(value) { return String(value ?? '').trim() }

// One tracker announce URL, or null: udp, http(s) or websocket, a public host, no username or password, and short.
// The host is checked as written (an IP address must be public); qBittorrent resolves names itself, over the VPN.
export function trackerUrl(value) {
  const raw = text(value)
  if (!raw || raw.length > MAX_TRACKER_LENGTH || /[\s\u0000-\u001f\u007f]/.test(raw)) return null
  let url
  try { url = new URL(raw) } catch { return null }
  if (!TRACKER_PROTOCOLS.has(url.protocol) || url.username || url.password || !url.hostname || url.hash) return null
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(host)) { if (unsafeAddress(host)) return null }
  else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|arpa)$/.test(host)) return null
  return url.toString()
}

// The key two tracker URLs are compared by: the same tracker written with a different case or a trailing slash is one.
export function trackerKey(value) { return text(value).toLowerCase().replace(/\/+$/, '') }

// A plain-text tracker list: one URL per line, blank lines between them; anything that is not a tracker is skipped.
export function parseTrackerList(body, limit = MAX_FROM_LIST) {
  const seen = new Set()
  const found = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const url = trackerUrl(line.replace(/#.*$/, ''))
    if (!url || seen.has(trackerKey(url))) continue
    seen.add(trackerKey(url))
    found.push(url)
    if (found.length >= limit) break
  }
  return found
}

// The trackers (tr=) of a magnet for exactly this info hash (40 hex characters), or none.
export function magnetTrackers(link, infoHash) {
  const value = text(link)
  if (!/^magnet:\?/i.test(value)) return []
  const params = new URLSearchParams(value.slice(value.indexOf('?') + 1))
  const hashes = params.getAll('xt').map((entry) => entry.match(/^urn:btih:([a-f0-9]{40})$/i)?.[1]?.toLowerCase()).filter(Boolean)
  if (!hashes.includes(text(infoHash).toLowerCase())) return []
  return params.getAll('tr').map(trackerUrl).filter(Boolean)
}

// Whether qBittorrent says the torrent is private: true, false, or null while it cannot tell yet (a magnet whose
// details have not arrived). qBittorrent 5 reports `private` in torrents/info and 4.6+ `is_private` in
// torrents/properties; every version marks the DHT, PeX and LSD entries of a private torrent's tracker list.
export function torrentPrivacy({ torrent = null, properties = null, trackers = [] } = {}) {
  if (torrent?.private === true || properties?.is_private === true) return true
  if ((Array.isArray(trackers) ? trackers : []).some((entry) => /^\*\*\s*\[/.test(text(entry?.url)) && /private/i.test(text(entry?.msg)))) return true
  const state = text(torrent?.state)
  if (state === 'metaDL' || state === 'forcedMetaDL') return null
  return false
}

// TOMIFY_TOMIFIN_TRACKER_LISTS: comma-separated https URLs of plain-text tracker lists, or "off" for none.
// Unset uses DEFAULT_TRACKER_LISTS.
export function trackerListsConfig(env = process.env) {
  const raw = text(env.TOMIFY_TOMIFIN_TRACKER_LISTS)
  if (!raw) return [...DEFAULT_TRACKER_LISTS]
  if (raw.toLowerCase() === 'off') return []
  return raw.split(',').map(text).filter((value) => { try { return new URL(value).protocol === 'https:' } catch { return false } })
}

// The public lists, fetched with Tomifin's link fetcher (public hosts only, size-capped) and kept for six hours.
// A list that fails is skipped; a cached copy is used while it lasts. Returns { trackers, failed }.
export function createPublicTrackerLists({ lists = DEFAULT_TRACKER_LISTS, fetchLink, now = () => Date.now() }) {
  const cache = new Map()
  return async function publicTrackers() {
    let failed = 0
    const fetched = await Promise.all(lists.map(async (list) => {
      const cached = cache.get(list)
      if (cached && cached.expiresAt > now()) return cached.trackers
      try {
        const { bytes } = await fetchLink(list, { maxBytes: MAX_LIST_BYTES })
        const trackers = parseTrackerList(Buffer.from(bytes ?? []).toString('utf8'))
        cache.set(list, { trackers, expiresAt: now() + LIST_TTL_MS })
        return trackers
      } catch {
        failed += 1
        return cached?.trackers || []
      }
    }))
    return { trackers: fetched.flat(), failed, lists: lists.length }
  }
}

// The new trackers to add, in order: those other sites list for this torrent first, then the public lists, leaving
// out any the torrent already has or that are not acceptable trackers, and stopping at MAX_NEW_TRACKERS.
export function newTrackers({ existing = [], fromSearch = [], fromLists = [] }) {
  const seen = new Set(existing.map((entry) => trackerKey(typeof entry === 'string' ? entry : entry?.url)))
  const picked = { search: [], lists: [] }
  for (const [kind, urls] of [['search', fromSearch], ['lists', fromLists]]) {
    for (const candidate of urls) {
      if (picked.search.length + picked.lists.length >= MAX_NEW_TRACKERS) break
      const url = trackerUrl(candidate)
      if (!url) continue
      const key = trackerKey(url)
      if (seen.has(key)) continue
      seen.add(key)
      picked[kind].push(url)
    }
  }
  return picked
}
