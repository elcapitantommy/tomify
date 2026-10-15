// Windows-1252 code points for bytes 0x80-0x9F; every other single byte maps to the same Latin-1 code point.
const windows1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178]

function legacyCodePoint(byte) {
  return byte >= 0x80 && byte <= 0x9f ? windows1252[byte - 0x80] : byte
}

function utf8Sequence(bytes, index) {
  const lead = bytes[index]
  let length, codePoint, minimum
  if (lead >= 0xc2 && lead <= 0xdf) { length = 2; codePoint = lead & 0x1f; minimum = 0x80 }
  else if (lead >= 0xe0 && lead <= 0xef) { length = 3; codePoint = lead & 0x0f; minimum = 0x800 }
  else if (lead >= 0xf0 && lead <= 0xf4) { length = 4; codePoint = lead & 0x07; minimum = 0x10000 }
  else return null
  if (index + length > bytes.length) return null
  for (let offset = 1; offset < length; offset += 1) {
    const next = bytes[index + offset]
    if ((next & 0xc0) !== 0x80) return null
    codePoint = (codePoint << 6) | (next & 0x3f)
  }
  if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null
  return { codePoint, length }
}

/**
 * Decodes tool output that should be UTF-8 but may carry tag bytes in a legacy encoding.
 * Valid UTF-8 is kept as is; any byte that is not part of a valid UTF-8 sequence is read
 * as Windows-1252, so a Latin-1 "M\xF6tley Cr\xFCe" tag becomes "Mötley Crüe" instead of "M�tley Cr�e".
 */
export function decodeToolOutput(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  let output = ''
  let asciiStart = 0
  let index = 0
  while (index < bytes.length) {
    if (bytes[index] < 0x80) { index += 1; continue }
    if (asciiStart < index) output += bytes.toString('latin1', asciiStart, index)
    const sequence = utf8Sequence(bytes, index)
    if (sequence) { output += String.fromCodePoint(sequence.codePoint); index += sequence.length }
    else { output += String.fromCodePoint(legacyCodePoint(bytes[index])); index += 1 }
    asciiStart = index
  }
  if (asciiStart < bytes.length) output += bytes.toString('latin1', asciiStart)
  return output
}

/** Accent-, case- and spacing-insensitive form of a name, so "Mötley Crüe" and "motley  crue" compare equal. */
export function foldName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()
}

/** True when a value still carries U+FFFD, i.e. a decoder upstream already lost the original characters. */
export function hasReplacementCharacter(value) {
  return String(value ?? '').includes('�')
}

function matchesWithLostCharacters(mangled, requested) {
  const pattern = foldName(mangled).split('�').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.{1,2}')
  return new RegExp(`^${pattern}$`, 'u').test(foldName(requested))
}

/**
 * Chooses between a name read from the downloaded files' tags and the name Tom asked for.
 * The requested spelling wins when the tag is the same name with only accents changed (so a
 * "Mötley Crüe" release joins an existing "Motley Crue"), or when the tag was mangled to U+FFFD
 * and still lines up with the request. Otherwise the tag wins, so plain case differences or
 * different artists on a compilation keep their own tags.
 */
export function preferRequestedName(tagValue, requestedValue) {
  const tag = String(tagValue ?? '').trim()
  const requested = String(requestedValue ?? '').trim()
  if (!tag) return requested || null
  if (!requested) return tag
  if (hasReplacementCharacter(tag)) return matchesWithLostCharacters(tag, requested) ? requested : tag
  const sameIgnoringCase = tag.toLocaleLowerCase('en') === requested.toLocaleLowerCase('en')
  return !sameIgnoringCase && foldName(tag) === foldName(requested) ? requested : tag
}
