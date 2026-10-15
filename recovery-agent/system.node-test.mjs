import test from 'node:test'
import assert from 'node:assert/strict'
import { rebootConfig, scheduleReboot } from './system.mjs'

function fakes() {
  const spawned = []
  const timers = []
  return {
    spawned, timers,
    spawn: (command, args, options) => { spawned.push({ command, args, options }); return { on() {}, unref() {} } },
    setTimer: (callback, delay) => { timers.push({ callback, delay }) },
  }
}

test('remote reboot is disabled unless explicitly enabled', () => {
  assert.equal(rebootConfig({}).enabled, false)
  assert.equal(rebootConfig({ TOMIFY_RECOVERY_ALLOW_REBOOT: 'yes' }).enabled, false)
  assert.deepEqual(rebootConfig({ TOMIFY_RECOVERY_ALLOW_REBOOT: ' TRUE ' }), { enabled: true, systemctl: '/usr/bin/systemctl' })
  assert.equal(rebootConfig({ TOMIFY_RECOVERY_ALLOW_REBOOT: 'true', SYSTEMCTL_PATH: '/bin/systemctl' }).systemctl, '/bin/systemctl')
})

test('a disabled server refuses to reboot and schedules nothing', () => {
  const fake = fakes()
  assert.throws(() => scheduleReboot({ confirm: 'reboot' }, { config: rebootConfig({}), ...fake }), /Remote reboot is disabled/)
  assert.equal(fake.timers.length, 0)
})

test('reboot requires the confirmation word', () => {
  const fake = fakes()
  const config = rebootConfig({ TOMIFY_RECOVERY_ALLOW_REBOOT: 'true' })
  assert.throws(() => scheduleReboot({}, { config, ...fake }), /requires confirmation/)
  assert.throws(() => scheduleReboot({ confirm: true }, { config, ...fake }), /requires confirmation/)
  assert.equal(fake.timers.length, 0)
})

test('a confirmed reboot answers first, then runs systemctl reboot without a shell', () => {
  const fake = fakes()
  const result = scheduleReboot({ confirm: 'reboot' }, { config: rebootConfig({ TOMIFY_RECOVERY_ALLOW_REBOOT: 'true' }), ...fake, delayMs: 3000 })
  assert.equal(result.rebooting, true)
  assert.ok(Date.parse(result.scheduledAt) > Date.now())
  assert.equal(fake.spawned.length, 0)
  assert.equal(fake.timers[0].delay, 3000)
  fake.timers[0].callback()
  assert.deepEqual(fake.spawned, [{ command: '/usr/bin/systemctl', args: ['reboot'], options: { detached: true, stdio: 'ignore' } }])
})
