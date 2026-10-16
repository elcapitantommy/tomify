// Album covers uploaded from the device are shrunk to at most 1200px and re-encoded as JPEG in the
// browser, so phone photos and large scans fit the Worker's 1 MB limit.
export const artworkUploadMaxDimension = 1200
const maxEncodedBytes = 1_000_000

export interface PreparedArtwork { image: string; width: number; height: number }

export function fitWithin(width: number, height: number, max = artworkUploadMaxDimension) {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export async function prepareArtworkUpload(file: File): Promise<PreparedArtwork> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } catch { throw new Error('That image could not be opened. Try a JPEG or PNG.') }
  const { width, height } = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot prepare images for upload.')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const image = canvas.toDataURL('image/jpeg', quality)
    if (image.length * 0.75 <= maxEncodedBytes) return { image, width, height }
  }
  throw new Error('That image is too detailed to upload. Try a smaller one.')
}
