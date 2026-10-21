// Web Push without a library: VAPID (RFC 8292) to identify the sender, and aes128gcm (RFC 8291) to encrypt the
// message for the browser's push service, using only Web Crypto.

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

const encoder = new TextEncoder()

export function base64Url(bytes: ArrayBuffer | Uint8Array) {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (character) => character.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

// A new VAPID key pair: the public key as the raw uncompressed point, the private key as the JWK `d`.
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer
  return { publicKey: base64Url(raw), privateKey: jwk.d!, subject }
}

async function vapidHeader(keys: VapidKeys, endpoint: string, now: number) {
  const point = fromBase64Url(keys.publicKey)
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: base64Url(point.slice(1, 33)), y: base64Url(point.slice(33, 65)), d: keys.privateKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = base64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64Url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`))
  return `vapid t=${header}.${claims}.${base64Url(signature)}, k=${keys.publicKey}`
}

async function hkdf(salt: Uint8Array, secret: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

// The encrypted body for one subscription (a single aes128gcm record).
export async function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, payload: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const clientKey = fromBase64Url(target.p256dh)
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const localPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey) as ArrayBuffer)
  const client = await crypto.subtle.importKey('raw', clientKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: client } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], local.privateKey, 256))
  const ikm = await hkdf(fromBase64Url(target.auth), shared, concat(encoder.encode('WebPush: info\0'), clientKey, localPublic), 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(encoder.encode(payload), new Uint8Array([2]))))
  const header = new Uint8Array(21 + localPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = localPublic.length
  header.set(localPublic, 21)
  return concat(header, cipher)
}

// Sends one message. Returns the push service's status: 201 is sent, 404 and 410 mean the subscription is gone.
export async function sendPush(keys: VapidKeys, target: PushTarget, payload: string, now = Date.now(), fetcher: typeof fetch = fetch) {
  const response = await fetcher(target.endpoint, {
    method: 'POST',
    headers: { authorization: await vapidHeader(keys, target.endpoint, now), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
    body: await encryptPayload(target, payload),
  })
  return response.status
}
