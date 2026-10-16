import test from 'node:test'
import assert from 'node:assert/strict'
import { agentStatusResponse, healthResponse, TOMIFY_AGENT_CONTRACT } from './health.mjs'

test('public health exposes only availability and version', () => {
  assert.deepEqual(healthResponse({}, '0.1.0'), { ok: true, version: '0.1.0' })
  assert.deepEqual(Object.keys(healthResponse({ TOMIFY_VERSION: 'release-123' }, '0.1.0')), ['ok', 'version'])
})

test('configured version wins and an unavailable version is null', () => {
  assert.deepEqual(healthResponse({ TOMIFY_VERSION: ' release-123 ' }, '0.1.0'), { ok: true, version: 'release-123' })
  assert.deepEqual(healthResponse({}, null), { ok: true, version: null })
})

test('authenticated status includes the same agent version and its contract', () => {
  const status = agentStatusResponse(healthResponse({ TOMIFY_VERSION: 'abc1234' }), { backends: [], reboot: 'disabled' })
  assert.deepEqual(status, { backends: [], reboot: 'disabled', version: 'abc1234', contract: 2 })
  assert.equal(TOMIFY_AGENT_CONTRACT, 2)
})
