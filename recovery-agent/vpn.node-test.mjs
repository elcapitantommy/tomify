import test from 'node:test'
import assert from 'node:assert/strict'
import { createVpnController, parseNordSettings, parseNordStatus, vpnConfig, vpnSafetyProblem } from './vpn.mjs'

const connected = '\r-\r  \r\r-\r  \rStatus: Connected\nServer: United Kingdom #2214\nHostname: uk2214.nordvpn.com\nIP: 194.35.233.10\nCountry: United Kingdom\nCity: London\nCurrent technology: NORDLYNX\nCurrent protocol: UDP\nTransfer: 1.2 GiB received, 80 MiB sent\nUptime: 2 hours 5 minutes\n'
const safeSettings = 'Technology: NORDLYNX\nFirewall: disabled\nFirewall Mark: 0xe1f1\nRouting: enabled\nAnalytics: disabled\nKill Switch: disabled\nThreat Protection Lite: disabled\nNotify: disabled\nAuto-connect: enabled\nIPv6: disabled\nMeshnet: disabled\nDNS: disabled\nLAN Discovery: enabled\nAllowlisted ports:\n\t      22 (TCP)\n'

function fakeRun(outputs) {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args])
      const output = outputs[args[0]]
      if (output instanceof Error) throw output
      return { stdout: typeof output === 'function' ? output() : output ?? '', stderr: '' }
    },
  }
}

const enabled = vpnConfig({ TOMIFY_RECOVERY_ALLOW_VPN_CONTROL: 'true' })

test('VPN control is off unless explicitly enabled and connects to the UK by default', () => {
  assert.equal(vpnConfig({}).enabled, false)
  assert.equal(vpnConfig({ TOMIFY_RECOVERY_ALLOW_VPN_CONTROL: 'yes' }).enabled, false)
  assert.deepEqual(enabled, { enabled: true, nordvpn: '/usr/bin/nordvpn', target: 'United_Kingdom' })
  assert.equal(vpnConfig({ TOMIFY_VPN_CONNECT_TARGET: 'Germany', NORDVPN_PATH: '/bin/nordvpn' }).target, 'Germany')
})

test('status output is parsed through the spinner', () => {
  assert.deepEqual(parseNordStatus(connected), { state: 'connected', server: 'United Kingdom #2214', country: 'United Kingdom', city: 'London', ip: '194.35.233.10', technology: 'NORDLYNX', uptime: '2 hours 5 minutes' })
  assert.equal(parseNordStatus('\r-\r  \rStatus: Disconnected\n').state, 'disconnected')
  assert.equal(parseNordStatus('Whoops! Cannot reach System Daemon.').state, 'unknown')
})

test('only a disabled firewall and kill switch count as safe', () => {
  assert.deepEqual(parseNordSettings(safeSettings), { firewall: false, killSwitch: false, autoConnect: true })
  assert.equal(vpnSafetyProblem(parseNordSettings(safeSettings)), null)
  assert.match(vpnSafetyProblem(parseNordSettings(safeSettings.replace('Firewall: disabled', 'Firewall: enabled'))), /firewall/)
  assert.match(vpnSafetyProblem(parseNordSettings(safeSettings.replace('Kill Switch: disabled', 'Kill Switch: enabled'))), /kill switch/)
  assert.match(vpnSafetyProblem(parseNordSettings('Technology: NORDLYNX\n')), /firewall/)
})

test('a disabled agent reports it and refuses changes without running nordvpn', async () => {
  const fake = fakeRun({})
  const vpn = createVpnController({ config: vpnConfig({}), run: fake.run })
  assert.deepEqual(await vpn.status(), { control: 'disabled', state: 'unknown' })
  await assert.rejects(vpn.change('disconnect'), /VPN control is disabled/)
  assert.equal(fake.calls.length, 0)
})

test('status reports the connection and the safety settings', async () => {
  const vpn = createVpnController({ config: enabled, run: fakeRun({ status: connected, settings: safeSettings }).run })
  const status = await vpn.status()
  assert.equal(status.state, 'connected')
  assert.equal(status.country, 'United Kingdom')
  assert.equal(status.firewall, false)
  assert.equal(status.killSwitch, false)
  assert.equal(status.target, 'United_Kingdom')
})

test('an unreachable daemon is reported as unavailable instead of failing', async () => {
  const vpn = createVpnController({ config: enabled, run: fakeRun({ status: new Error('nordvpn failed: exit 1'), settings: safeSettings }).run })
  assert.deepEqual(await vpn.status(), { control: 'enabled', state: 'unavailable', message: 'nordvpn failed: exit 1', busy: false })
})

test('connect and disconnect run only the fixed commands after a safety check', async () => {
  let state = 'Disconnected'
  const fake = fakeRun({ status: () => `Status: ${state}\n`, settings: safeSettings, connect: () => { state = 'Connected'; return 'Connected' }, disconnect: () => { state = 'Disconnected'; return 'Disconnected' } })
  const vpn = createVpnController({ config: enabled, run: fake.run })
  assert.equal((await vpn.change('connect')).state, 'connected')
  assert.deepEqual(fake.calls.slice(0, 2), [['/usr/bin/nordvpn', 'settings'], ['/usr/bin/nordvpn', 'connect', 'United_Kingdom']])
  fake.calls.length = 0
  assert.equal((await vpn.change('disconnect')).state, 'disconnected')
  assert.deepEqual(fake.calls.slice(0, 2), [['/usr/bin/nordvpn', 'settings'], ['/usr/bin/nordvpn', 'disconnect']])
})

test('changes are refused while the firewall or kill switch is on, and unknown actions are rejected', async () => {
  const fake = fakeRun({ settings: safeSettings.replace('Kill Switch: disabled', 'Kill Switch: enabled') })
  const vpn = createVpnController({ config: enabled, run: fake.run })
  await assert.rejects(vpn.change('disconnect'), /kill switch/)
  await assert.rejects(vpn.change('reconnect'), /connect or disconnect/)
  assert.deepEqual(fake.calls, [['/usr/bin/nordvpn', 'settings']])
})

test('a bad connect target is refused before anything runs', async () => {
  const fake = fakeRun({ settings: safeSettings })
  const vpn = createVpnController({ config: vpnConfig({ TOMIFY_RECOVERY_ALLOW_VPN_CONTROL: 'true', TOMIFY_VPN_CONNECT_TARGET: 'uk; reboot' }), run: fake.run })
  await assert.rejects(vpn.change('connect'), /TOMIFY_VPN_CONNECT_TARGET/)
  assert.equal(fake.calls.length, 0)
})

test('only one change runs at a time', async () => {
  let release
  const fake = fakeRun({ settings: safeSettings, status: 'Status: Connected\n' })
  const slow = async (command, args) => args[0] === 'connect' ? new Promise((resolve) => { release = () => resolve({ stdout: '', stderr: '' }) }) : fake.run(command, args)
  const vpn = createVpnController({ config: enabled, run: slow })
  const first = vpn.change('connect')
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(vpn.change('disconnect'), /already in progress/)
  release()
  assert.equal((await first).state, 'connected')
})
