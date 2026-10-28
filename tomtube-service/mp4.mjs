// Reading the segment index of YouTube's fragmented MP4s.
//
// Each adaptive format starts with `ftyp` and `moov` (the initialisation data), then a `sidx` box
// listing every fragment's byte size and duration, then the fragments (`moof` + `mdat`). From the
// first few kilobytes TomTube knows where every fragment is, so it can describe the file to Safari as
// an HLS playlist of byte ranges (hls.mjs) without downloading, remuxing or transcoding anything.

export class Mp4IndexError extends Error {
  constructor(message) { super(message); this.name = 'Mp4IndexError' }
}

// Top-level boxes in `buffer` (which starts at byte 0 of the file): [{ type, start, size, headerSize }].
// A box that runs past the end of the buffer is still listed, so the caller can fetch more.
export function topLevelBoxes(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > buffer.length) { boxes.push({ type, start: offset, size: null, headerSize: 16 }); break }
      size = Number(buffer.readBigUInt64BE(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      boxes.push({ type, start: offset, size: null, headerSize })
      break
    }
    if (size < headerSize) throw new Mp4IndexError(`Invalid ${type} box size.`)
    boxes.push({ type, start: offset, size, headerSize })
    offset += size
  }
  return boxes
}

// Parses a complete `sidx` box. `boxStart` is its offset in the file.
export function parseSidx(buffer, boxStart = 0) {
  const top = topLevelBoxes(buffer.subarray(0, Math.min(buffer.length, 16)))[0]
  if (!top || top.type !== 'sidx' || top.size === null || top.size > buffer.length) throw new Mp4IndexError('Incomplete sidx box.')
  let offset = top.headerSize
  const version = buffer.readUInt8(offset)
  offset += 4 // version + flags
  offset += 4 // reference_ID
  const timescale = buffer.readUInt32BE(offset)
  offset += 4
  let earliest
  let firstOffset
  if (version === 0) {
    earliest = buffer.readUInt32BE(offset)
    firstOffset = buffer.readUInt32BE(offset + 4)
    offset += 8
  } else {
    earliest = Number(buffer.readBigUInt64BE(offset))
    firstOffset = Number(buffer.readBigUInt64BE(offset + 8))
    offset += 16
  }
  offset += 2 // reserved
  const count = buffer.readUInt16BE(offset)
  offset += 2
  if (!timescale) throw new Mp4IndexError('sidx has no timescale.')
  if (offset + count * 12 > top.size) throw new Mp4IndexError('sidx is shorter than its reference count.')
  const references = []
  let position = boxStart + top.size + firstOffset
  for (let index = 0; index < count; index += 1) {
    const word = buffer.readUInt32BE(offset)
    const duration = buffer.readUInt32BE(offset + 4)
    offset += 12
    if (word >>> 31) throw new Mp4IndexError('Nested sidx indexes are not supported.')
    const size = word & 0x7fffffff
    references.push({ start: position, end: position + size - 1, duration: duration / timescale })
    position += size
  }
  return { timescale, earliest: earliest / timescale, references }
}

// How many bytes from the start of the file are needed to read the whole index: grows `have` until
// the moov and sidx boxes are complete. Returns { needed } or the finished index.
export function readIndex(buffer, totalSize = null) {
  const boxes = topLevelBoxes(buffer)
  const moov = boxes.find((box) => box.type === 'moov')
  const sidx = boxes.find((box) => box.type === 'sidx')
  const firstFragment = boxes.find((box) => box.type === 'moof')
  if (!moov || moov.size === null || moov.start + moov.size > buffer.length) {
    if (!moov && boxes.some((box) => box.type === 'mdat' || box.type === 'moof')) throw new Mp4IndexError('The file has no moov box before its media data.')
    return { needed: moov?.size ? moov.start + moov.size + 4096 : buffer.length * 2 }
  }
  if (!sidx) {
    if (firstFragment || boxes.some((box) => box.type === 'mdat')) throw new Mp4IndexError('The file has no segment index (sidx).')
    return { needed: buffer.length * 2 }
  }
  if (sidx.size === null || sidx.start + sidx.size > buffer.length) return { needed: sidx.start + (sidx.size || 65536) }
  const index = parseSidx(buffer.subarray(sidx.start, sidx.start + sidx.size), sidx.start)
  if (!index.references.length) throw new Mp4IndexError('The segment index is empty.')
  const last = index.references[index.references.length - 1]
  if (totalSize && last.end > totalSize - 1) throw new Mp4IndexError('The segment index runs past the end of the file.')
  return {
    init: { start: 0, end: moov.start + moov.size - 1 },
    timescale: index.timescale,
    segments: index.references,
    duration: index.references.reduce((sum, reference) => sum + reference.duration, 0),
  }
}

// Joins neighbouring fragments into segments of at least `minSeconds`, so the phone makes fewer requests.
export function groupSegments(segments, minSeconds = 4) {
  const grouped = []
  let current = null
  for (const segment of segments) {
    if (!current) { current = { ...segment }; continue }
    if (current.duration >= minSeconds || segment.start !== current.end + 1) { grouped.push(current); current = { ...segment }; continue }
    current.end = segment.end
    current.duration += segment.duration
  }
  if (current) grouped.push(current)
  return grouped
}
