import { extname } from 'node:path'

const audioExtensions = new Set(['.flac', '.wav', '.aiff', '.aif', '.m4a', '.mp3', '.ogg', '.opus', '.mka', '.webm', '.aac'])
const formatPreference = ['flac', 'alac', 'wave', 'wav', 'aiff', 'm4a', 'aac', 'ogg', 'opus', 'mp3', 'webm']

function text(value) { return String(value || '').trim() }

export function archiveSearchUrl(track, rows = 8) {
  const artist = text(track?.artist).slice(0, 240)
  const title = text(track?.title).slice(0, 240) || text(track?.album).slice(0, 240)
  if (!artist && !title) throw new Error('An artist, album or title is required.')
  const phrase = [artist, title].filter(Boolean).join(' ').replace(/[\\"]/g, ' ').replace(/\s+/g, ' ').trim()
  const url = new URL('https://archive.org/advancedsearch.php')
  url.searchParams.set('q', `mediatype:audio AND (title:("${phrase}") OR description:("${phrase}") OR subject:("${phrase}"))`)
  for (const field of ['identifier', 'title', 'creator', 'description', 'licenseurl', 'rights']) url.searchParams.append('fl[]', field)
  url.searchParams.set('rows', String(Math.max(1, Math.min(20, rows))))
  url.searchParams.set('page', '1')
  url.searchParams.set('output', 'json')
  return url.toString()
}

export function archiveMetadataUrl(identifier) {
  const value = text(identifier)
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error('Internet Archive identifier is invalid.')
  return `https://archive.org/metadata/${encodeURIComponent(value)}`
}

export function archiveDownloadUrl(identifier, filename) {
  const id = text(identifier)
  const name = text(filename)
  const parts = name.split('/')
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id) || !name || name.length > 500 || name.includes('\0') || name.startsWith('/') || name.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Internet Archive file reference is invalid.')
  const encodedName = parts.map((part) => encodeURIComponent(part)).join('/')
  return `https://archive.org/download/${encodeURIComponent(id)}/${encodedName}`
}

export function validateArchiveDownloadUrl(value) {
  const url = new URL(String(value || ''))
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || !(hostname === 'archive.org' || hostname.endsWith('.us.archive.org'))) throw new Error('Internet Archive download redirected to an untrusted host.')
  return url.toString()
}

function number(value) {
  const parsed = Number.parseFloat(String(value || ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function formatRank(file) {
  const format = text(file.format).toLowerCase()
  const extension = extname(text(file.name)).slice(1).toLowerCase()
  const index = formatPreference.findIndex((entry) => format.includes(entry) || extension === entry)
  return index < 0 ? formatPreference.length : index
}

export function selectArchiveAudioFiles(metadata, limit = 4) {
  const files = Array.isArray(metadata?.files) ? metadata.files : []
  return files.filter((file) => {
    const name = text(file?.name)
    return name && !name.startsWith('__ia_') && audioExtensions.has(extname(name).toLowerCase()) && number(file?.size)
  }).sort((left, right) => {
    const source = (text(left.source).toLowerCase() === 'original' ? 0 : 1) - (text(right.source).toLowerCase() === 'original' ? 0 : 1)
    return source || formatRank(left) - formatRank(right) || (number(right.bitrate) || 0) - (number(left.bitrate) || 0) || (number(right.size) || 0) - (number(left.size) || 0)
  }).slice(0, Math.max(1, limit))
}

export function archiveCandidate(identifier, itemMetadata, file) {
  const filename = text(file.name)
  const itemTitle = text(itemMetadata?.title)
  const creator = Array.isArray(itemMetadata?.creator) ? itemMetadata.creator.join(', ') : text(itemMetadata?.creator)
  const fingerprint = text(file.sha1 || file.md5 || filename).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32)
  return {
    externalId: `${identifier}:${fingerprint}`.slice(0, 120),
    url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    title: text(file.title) || filename.replace(/\.[^.]+$/, '') || itemTitle,
    channel: creator || 'Internet Archive',
    channelId: identifier,
    duration: number(file.length),
    thumbnail: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    provenance: {
      provider: 'internet-archive', identifier, filename, downloadUrl: archiveDownloadUrl(identifier, filename),
      itemTitle, creator: creator || null, fileFormat: text(file.format) || null, fileSource: text(file.source) || null,
      size: number(file.size), bitrate: number(file.bitrate), md5: text(file.md5) || null, sha1: text(file.sha1) || null,
      licenseUrl: text(itemMetadata?.licenseurl) || null, rights: text(itemMetadata?.rights) || null,
      collection: itemMetadata?.collection || null,
    },
  }
}
