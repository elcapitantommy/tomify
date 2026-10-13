import { extname } from 'node:path'

export function recoveryDerivativeExtension(sourcePath, sourceQuality) {
  const sourceExtension = extname(String(sourcePath || '')).toLowerCase() || '.mka'
  const codec = String(sourceQuality?.codec || '').toLowerCase()
  const containers = String(sourceQuality?.container || '').toLowerCase().split(',').map((value) => value.trim())
  return sourceExtension === '.webm' && codec === 'opus' && containers.includes('webm') ? '.opus' : sourceExtension
}

export function recoveryDerivativeOperation(sourceExtension, derivativeExtension, artworkEmbedded = false) {
  if (artworkEmbedded) return 'ffmpeg-stream-copy-tagging-with-attached-artwork'
  return sourceExtension !== derivativeExtension ? 'ffmpeg-stream-copy-remux-and-tagging' : 'ffmpeg-stream-copy-tagging'
}
