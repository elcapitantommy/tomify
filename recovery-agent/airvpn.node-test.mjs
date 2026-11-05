import assert from 'node:assert/strict'
import test from 'node:test'
import { airvpnConfig, createAirvpnMonitor, interfaceAddress, parseAirvpnCheck } from './airvpn.mjs'

const answer = (airvpn, name = 'Netherlands') => JSON.stringify({ ip: '213.152.161.153', ipv4: true, ipv6: false, airvpn, geo: { code: 'nl', name }, result: 'ok' })

test('AirVPN is off unless an interface is named, and refuses odd names', () => {
  assert.equal(airvpnConfig({}).enabled, false)
  assert.deepEqual(airvpnConfig({ TOMIFY_AIRVPN_INTERFACE: ' airvpn ' }), { enabled: true, interface: 'airvpn', checkUrl: 'https://airvpn.org/api/whatismyip/' })
  assert.equal(airvpnConfig({ TOMIFY_AIRVPN_INTERFACE: '../../etc' }).interface, null)
})

test('the check answer says whether traffic came through AirVPN', () => {
  assert.deepEqual(parseAirvpnCheck(answer(true)), { airvpn: true, country: 'Netherlands' })
  assert.deepEqual(parseAirvpnCheck(answer(false, '')), { airvpn: false, country: null })
  assert.equal(parseAirvpnCheck('<html>'), null)
  assert.equal(parseAirvpnCheck(JSON.stringify({ result: 'ok' })), null)
})

test('the interface address is its IPv4 one', () => {
  assert.equal(interfaceAddress('airvpn', { airvpn: [{ family: 'IPv6', address: 'fd00::1' }, { family: 'IPv4', address: '10.160.0.41' }] }), '10.160.0.41')
  assert.equal(interfaceAddress('airvpn', {}), null)
})

test('the monitor checks the interface, then asks AirVPN from its address, and caches the answer', async () => {
  let clock = 0
  const calls = []
  let reply = answer(true)
  const monitor = (overrides = {}) => createAirvpnMonitor({
    config: airvpnConfig({ TOMIFY_AIRVPN_INTERFACE: 'airvpn' }),
    readFlags: async () => 0x1091,
    addressOf: () => '10.160.0.41',
    fetchCheck: async (url, address) => { calls.push([url, address]); if (reply instanceof Error) throw reply; return reply },
    now: () => clock,
    ...overrides,
  })
  const live = monitor()
  assert.deepEqual(await live.status(), { state: 'connected', country: 'Netherlands', reason: null })
  assert.deepEqual(calls, [['https://airvpn.org/api/whatismyip/', '10.160.0.41']])
  await Promise.all([live.status(), live.status()])
  assert.equal(calls.length, 1)
  clock = 61_000
  reply = new Error('timed out')
  assert.deepEqual(await live.status(), { state: 'disconnected', country: null, reason: 'no-traffic' })
  reply = answer(false)
  clock = 70_000
  assert.equal((await live.status()).reason, 'no-traffic')
  clock = 77_000
  assert.deepEqual(await live.status(), { state: 'disconnected', country: null, reason: 'not-through-airvpn' })

  assert.equal((await monitor({ readFlags: async () => { throw new Error('ENOENT') } }).status()).reason, 'no-interface')
  assert.equal((await monitor({ readFlags: async () => 0x1090 }).status()).reason, 'interface-down')
  assert.equal((await monitor({ addressOf: () => null }).status()).reason, 'no-address')
  reply = 'not json'
  assert.equal((await monitor().status()).state, 'unknown')
  assert.equal(await createAirvpnMonitor({ config: airvpnConfig({}) }).status(), null)
})
