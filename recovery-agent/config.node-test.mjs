import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRecoveryAuthConfig } from './config.mjs'

test('recovery startup rejects a missing token by default', () => {
  assert.throws(() => validateRecoveryAuthConfig({}), /TOMIFY_RECOVERY_TOKEN is required/)
})

test('recovery startup rejects a short token', () => {
  assert.throws(() => validateRecoveryAuthConfig({ TOMIFY_RECOVERY_TOKEN: 'too-short' }), /at least 32 characters/)
})

test('recovery startup accepts a securely sized token', () => {
  const config = validateRecoveryAuthConfig({ TOMIFY_RECOVERY_HOST: '127.0.0.1', TOMIFY_RECOVERY_TOKEN: 'a'.repeat(32) })
  assert.deepEqual(config, { host: '127.0.0.1', token: 'a'.repeat(32), insecureLoopback: false })
})

test('recovery startup permits explicit insecure loopback development mode', () => {
  const config = validateRecoveryAuthConfig({ TOMIFY_RECOVERY_HOST: '::1', TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK: 'true' })
  assert.deepEqual(config, { host: '::1', token: '', insecureLoopback: true })
})

test('recovery startup rejects insecure mode on a non-loopback bind', () => {
  assert.throws(() => validateRecoveryAuthConfig({ TOMIFY_RECOVERY_HOST: '0.0.0.0', TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK: 'true' }), /only when TOMIFY_RECOVERY_HOST is loopback/)
  assert.throws(() => validateRecoveryAuthConfig({ TOMIFY_RECOVERY_HOST: '127.999.0.1', TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK: 'true' }), /only when TOMIFY_RECOVERY_HOST is loopback/)
})
