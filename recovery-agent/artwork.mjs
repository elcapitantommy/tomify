import { extname } from 'node:path'

const artworkHosts = ['mzstatic.com', 'i.scdn.co', 'coverartarchive.org', 'archive.org', 'ytimg.com', 'ggpht.com']
const embeddedArtworkExtensions = new Set(['.m4a', '.mp4', '.mp3', '.flac'])

export function validateArtworkUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Artwork must use HTTPS.')
  const hostname = url.hostname.toLowerCase()
  if (!artworkHosts.some((host) => hostname === host || hostname.endsWith('.' + host))) throw new Error('Artwork host is not allowed.')
  return url.toString()
}

export function detectImageMime(buffer, contentType) {
  const header = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!header.startsWith('image/')) throw new Error('Artwork response is not an image.')
  const bytes = new Uint8Array(buffer)
  const detected = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png'
      : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 ? 'image/webp' : null
  if (!detected) throw new Error('Artwork bytes are not a supported JPEG, PNG, or WebP image.')
  if (header !== detected && !(header === 'image/jpg' && detected === 'image/jpeg')) throw new Error('Artwork MIME type does not match its content.')
  return detected
}

export function coverDimensions(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200) throw new Error('Artwork dimensions are too small.')
  const scale = Math.min(1, 1200 / Math.max(w, h))
  let outputWidth = Math.max(2, Math.round(w * scale / 2) * 2)
  let outputHeight = Math.max(2, Math.round(h * scale / 2) * 2)
  if (Math.abs(w / h - 1) <= 0.08) {
    const square = Math.min(1200, w, h)
    outputWidth = Math.max(2, Math.round(square / 2) * 2)
    outputHeight = outputWidth
  }
  return { width: outputWidth, height: outputHeight, filter: `scale=${outputWidth}:${outputHeight}` }
}

export function buildDerivativeArguments({ sourcePath, outputPath, coverPath, tags = [] }) {
  const extension = extname(outputPath).toLowerCase()
  const embedded = Boolean(coverPath && embeddedArtworkExtensions.has(extension))
  const args = ['-v', 'error', '-nostdin', '-n', '-i', sourcePath]
  if (embedded) args.push('-i', coverPath, '-map', '0:a:0', '-map', '1:v:0', '-map_metadata', '-1', '-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic')
  else args.push('-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'copy')
  if (extension === '.mp3' && embedded) args.push('-id3v2_version', '3')
  args.push(...tags, outputPath)
  return { args, embedded, storageMode: embedded ? 'embedded-and-cover-file' : coverPath ? 'cover-file-only' : 'none' }
}

export function buildArtworkProvenance(artwork, plan, coverPath) {
  if (!artwork) return null
  return { provider: artwork.provider, providerLabel: artwork.providerLabel, providerId: artwork.providerId, originalUrl: artwork.originalUrl, fetchedUrl: artwork.fetchedUrl, fetchedDimensions: artwork.fetchedDimensions, finalDimensions: artwork.finalDimensions, sourceMimeType: artwork.sourceMimeType, finalMimeType: artwork.finalMimeType, acquiredAt: artwork.acquiredAt, embedded: plan.embedded, storedAsCoverFile: true, coverPath, storageMode: plan.storageMode }
}
