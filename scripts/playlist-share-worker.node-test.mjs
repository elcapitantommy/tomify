import test from 'node:test'
import assert from 'node:assert/strict'
import { normaliseShareRecipients } from '../worker/features/playlist-share.ts'

test('share recipients are known accounts other than the owner, deduplicated case-insensitively', () => {
  assert.deepEqual(normaliseShareRecipients(['Anna', 'anna', 'tom', 'stranger', '', null], 'Tom', ['tom', 'anna', 'sam']), ['anna'])
  assert.deepEqual(normaliseShareRecipients('anna', 'tom', ['anna']), [])
  assert.deepEqual(normaliseShareRecipients(['sam', 'anna'], 'tom', ['anna', 'sam']), ['sam', 'anna'])
})
