// AES-GCM with a key derived from a secret string: `base64(iv).base64(ciphertext)`. Used for stored
// Spotify tokens and for short-lived media tokens (the recovery agent's lan.mjs reads the same format).
function bytesToBase64(bytes: Uint8Array) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

async function sealKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function seal(secret: string, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(secret), new TextEncoder().encode(text))
  return bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(encrypted))
}

// Throws for anything this secret did not seal.
export async function unseal(secret: string, value: string) {
  const [iv, encrypted] = value.split('.')
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, await sealKey(secret), base64ToBytes(encrypted)))
}
