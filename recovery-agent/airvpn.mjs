// AirVPN status for Tomifin's toolbar. qBittorrent is bound to an AirVPN WireGuard interface (wg-quick@airvpn,
// docs/TOMIFIN.md) while the rest of the box stays on NordVPN. Off unless TOMIFY_AIRVPN_INTERFACE names that
// interface.
//
// The agent runs unprivileged, so it cannot ask WireGuard for its last handshake. Instead it checks that the
// interface is up and has an IPv4 address, then asks AirVPN's own "what is my IP" API from that address. The box
// routes traffic from that address into the tunnel, so an answer saying it came through AirVPN proves the tunnel
// passes traffic. That answer is kept for a minute (AirVPN bans clients that send more than 600 requests in ten
// minutes; this sends at most ten).

import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { networkInterfaces } from 'node:os'

const INTERFACE_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/
const IFF_UP = 0x1
const MAX_BODY_BYTES = 64 * 1024

export function airvpnConfig(env = process.env) {
  const name = String(env.TOMIFY_AIRVPN_INTERFACE || '').trim()
  return {
    enabled: Boolean(name),
    interface: INTERFACE_PATTERN.test(name) ? name : null,
    checkUrl: String(env.TOMIFY_AIRVPN_CHECK_URL || '').trim() || 'https://airvpn.org/api/whatismyip/',
  }
}

// AirVPN's whatismyip answer: { ip, airvpn: true|false, geo: { code, name }, result: 'ok', ... }.
export function parseAirvpnCheck(body) {
  let value
  try { value = JSON.parse(String(body || '')) } catch { return null }
  if (!value || typeof value !== 'object' || typeof value.airvpn !== 'boolean') return null
  const country = typeof value.geo?.name === 'string' ? value.geo.name.trim().slice(0, 80) : ''
  return { airvpn: value.airvpn, country: country || null }
}

export function interfaceAddress(name, interfaces = networkInterfaces()) {
  const entry = (interfaces[name] || []).find((address) => address.family === 'IPv4' || address.family === 4)
  return entry?.address || null
}

async function readInterfaceFlags(name) {
  return Number.parseInt((await readFile(`/sys/class/net/${name}/flags`, 'utf8')).trim(), 16)
}

function fetchFrom(url, localAddress, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', localAddress, timeout: timeoutMs, headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`AirVPN's check answered ${response.statusCode}.`))
        return
      }
      let size = 0
      const chunks = []
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) req.destroy(new Error('AirVPN\'s check answered with too much data.'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('AirVPN\'s check did not answer in time.')))
    req.on('error', reject)
    req.end()
  })
}

// status() resolves to null when AirVPN is not set up here, otherwise { state, country, reason }.
// state is connected, disconnected or unknown; reason says why it is not connected.
export function createAirvpnMonitor({ config, readFlags = readInterfaceFlags, addressOf = (name) => interfaceAddress(name), fetchCheck = fetchFrom, now = () => Date.now(), cacheMs = 60_000, failureCacheMs = 15_000 }) {
  let cached = null
  let pending = null

  async function check(name) {
    let flags
    try { flags = await readFlags(name) } catch { return { state: 'disconnected', country: null, reason: 'no-interface' } }
    if (!Number.isFinite(flags) || !(flags & IFF_UP)) return { state: 'disconnected', country: null, reason: 'interface-down' }
    const address = addressOf(name)
    if (!address) return { state: 'disconnected', country: null, reason: 'no-address' }
    if (cached && cached.address === address && now() < cached.expires) return cached.value
    if (!pending) {
      pending = (async () => {
        let value
        try {
          const parsed = parseAirvpnCheck(await fetchCheck(config.checkUrl, address))
          value = !parsed ? { state: 'unknown', country: null, reason: 'bad-answer' }
            : parsed.airvpn ? { state: 'connected', country: parsed.country, reason: null }
            : { state: 'disconnected', country: null, reason: 'not-through-airvpn' }
        } catch {
          value = { state: 'disconnected', country: null, reason: 'no-traffic' }
        }
        cached = { address, value, expires: now() + (value.state === 'connected' ? cacheMs : failureCacheMs) }
        return value
      })().finally(() => { pending = null })
    }
    return pending
  }

  async function status() {
    if (!config.enabled) return null
    if (!config.interface) return { state: 'unknown', country: null, reason: 'bad-interface-name' }
    return check(config.interface)
  }

  return { status }
}
