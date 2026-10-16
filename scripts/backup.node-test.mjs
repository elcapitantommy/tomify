import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./backup.sh', import.meta.url))
const skip = process.platform === 'win32' && 'backup.sh runs on the Debian box and needs bash'
const secret = 'cf-token-that-must-not-leak'

// Stub wrangler and tar log every call and write the file they were asked for.
const wranglerStub = `#!/usr/bin/env bash
echo "wrangler $*" >> "$STUB_LOG"
if [[ "$1" == whoami ]]; then
  if [[ "$STUB_LOGGED_IN" == 1 ]]; then echo "You are logged in with an API Token, associated with the email tom@example.com."; else echo "You are not authenticated. Please run \\\`wrangler login\\\`."; fi
  exit 0
fi
while [[ $# -gt 0 ]]; do if [[ "$1" == --output ]]; then echo "CREATE TABLE t (id TEXT);" > "$2"; fi; shift; done
`
const tarStub = `#!/usr/bin/env bash
echo "tar $*" >> "$STUB_LOG"
[[ "$1" == -czf ]] && echo archive > "$2"
exit 0
`

function setup({ sql = 0, tars = 0, loggedIn = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tomify-backup-'))
  const bin = join(root, 'bin')
  const backups = join(root, 'backups')
  const state = join(root, 'state', 'tomify-recovery')
  for (const dir of [bin, backups, state]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(state, 'usenet-jobs.json'), '{}')
  writeFileSync(join(bin, 'wrangler'), wranglerStub)
  writeFileSync(join(bin, 'tar'), tarStub)
  chmodSync(join(bin, 'wrangler'), 0o755)
  chmodSync(join(bin, 'tar'), 0o755)
  for (let day = 1; day <= sql; day += 1) writeFileSync(join(backups, `tomify-d1-2025-01-${String(day).padStart(2, '0')}T033000Z.sql`), 'old')
  for (let day = 1; day <= tars; day += 1) writeFileSync(join(backups, `tomify-agent-state-2025-01-${String(day).padStart(2, '0')}T033000Z.tar.gz`), 'old')
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_LOG: log, STUB_LOGGED_IN: loggedIn ? '1' : '0', BACKUP_DIR: backups, TOMIFY_RECOVERY_STATE_DIR: state, CLOUDFLARE_API_TOKEN: secret }
  const run = (...args) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' })
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return { backups, state, run, calls }
}

test('dry run plans the export, archive and retention without running them', { skip }, () => {
  const { backups, state, run, calls } = setup({ sql: 15, tars: 14 })
  const result = run('--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\] would run: wrangler d1 export tomify-metadata --remote --output .*\/tomify-d1-\d{4}-\d\d-\d\dT\d{6}Z\.sql\.partial/)
  assert.match(result.stdout, new RegExp(`\\[dry-run\\] would run: tar -czf .*tomify-agent-state-.*\\.tar\\.gz\\.partial -C ${join(state, '..')} tomify-recovery`))
  // 15 old exports plus the new one leaves two to delete; 14 old archives plus the new one leaves one.
  const deletions = result.stdout.split('\n').filter((line) => line.startsWith('[dry-run] would delete')).map((line) => line.split('/').pop())
  assert.deepEqual(deletions, ['tomify-d1-2025-01-01T033000Z.sql', 'tomify-d1-2025-01-02T033000Z.sql', 'tomify-agent-state-2025-01-01T033000Z.tar.gz'])
  assert.deepEqual(calls(), ['wrangler whoami'])
  assert.equal(readdirSync(backups).length, 29)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|tom@example\\.com`))
})

test('a real run writes both backups and keeps the newest 14 of each', { skip }, () => {
  const { backups, run, calls } = setup({ sql: 15, tars: 3 })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const files = readdirSync(backups).sort()
  assert.equal(files.filter((name) => name.endsWith('.sql')).length, 14)
  assert.equal(files.filter((name) => name.endsWith('.tar.gz')).length, 4)
  assert.ok(!files.some((name) => name.endsWith('.partial')))
  assert.ok(!existsSync(join(backups, 'tomify-d1-2025-01-02T033000Z.sql')))
  assert.ok(existsSync(join(backups, 'tomify-d1-2025-01-03T033000Z.sql')))
  const newest = files.filter((name) => name.endsWith('.sql')).pop()
  assert.match(newest, /^tomify-d1-\d{4}-\d\d-\d\dT\d{6}Z\.sql$/)
  assert.equal(readFileSync(join(backups, newest), 'utf8'), 'CREATE TABLE t (id TEXT);\n')
  const [whoami, exportCall, tarCall] = calls()
  assert.equal(whoami, 'wrangler whoami')
  assert.match(exportCall, /^wrangler d1 export tomify-metadata --remote --output \S+\.sql\.partial$/)
  assert.match(tarCall, /^tar -czf \S+\.tar\.gz\.partial -C \S+ tomify-recovery$/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
})

test('stops with a clear error when wrangler is not logged in', { skip }, () => {
  const { backups, run, calls } = setup({ loggedIn: false })
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /wrangler is not logged in .*Run 'wrangler login'.*CLOUDFLARE_API_TOKEN/)
  assert.deepEqual(calls(), ['wrangler whoami'])
  assert.deepEqual(readdirSync(backups), [])
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
})

test('rejects unknown options and an invalid retention count', { skip }, () => {
  const { run } = setup()
  assert.equal(run('--keep').status, 2)
  const env = { ...process.env, BACKUP_KEEP: '0' }
  const result = spawnSync('bash', [script, '--dry-run'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /BACKUP_KEEP must be a positive whole number/)
})
