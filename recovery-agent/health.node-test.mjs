import test from 'node:test'
import assert from 'node:assert/strict'
import { healthResponse } from './health.mjs'

test('public health exposes only availability and version', () => {
  assert.deepEqual(healthResponse({}, '0.1.0'), { ok: true, version: '0.1.0' })
  assert.deepEqual(Object.keys(healthResponse({ TOMIFY_VERSION: 'release-123' }, '0.1.0')), ['ok', 'version'])
})

test('configured version wins and an unavailable version is null', () => {
  assert.deepEqual(healthResponse({ TOMIFY_VERSION: ' release-123 ' }, '0.1.0'), { ok: true, version: 'release-123' })
  assert.deepEqual(healthResponse({}, null), { ok: true, version: null })
})
