import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const drizzle = fileURLToPath(new URL('../drizzle/', import.meta.url))
const scripts = fileURLToPath(new URL('./', import.meta.url))
const workerBundle = fileURLToPath(new URL('../dist/server/index.js', import.meta.url))
const baselineScript = join(scripts, 'd1-baseline.sh')
const runtimeDdl = readFileSync(join(scripts, 'fixtures', 'd1-runtime-ddl.sql'), 'utf8')
const migrations = readdirSync(drizzle).filter((name) => name.endsWith('.sql')).sort()
// The migrations from the runtime-DDL era, which scripts/d1-baseline.sh and the legacy schema comparison cover.
const baselineEra = migrations.filter((name) => name < '0013')
const skip = process.platform === 'win32' && 'd1-baseline.sh runs on the Debian box and needs bash'

// wrangler's own d1_migrations table and per-file bookkeeping (wrangler-dist getCreateMigrationsTableQuery
// and buildMigrationQuery), so these tests see the database as `wrangler d1 migrations apply` leaves it.
const wranglerMigrationsTable = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`

function applyMigration(db, name) {
  db.exec(wranglerMigrationsTable)
  db.exec(`${readFileSync(join(drizzle, name), 'utf8')}\nINSERT INTO "d1_migrations" (name)\nvalues ('${name.replace(/'/g, "''")}');`)
}

function appliedMigrations(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get()
  return table ? db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => row.name) : []
}

const pendingMigrations = (db) => migrations.filter((name) => !appliedMigrations(db).includes(name))

function schemaOf(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'd1_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name).sort()]))
}

const indexesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)

// Every SQL string literal in the real unminified Wrangler bundle used by the route suite.
function workerSql() {
  const statements = []
  const source = readFileSync(workerBundle, 'utf8')
  for (const match of source.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)\b[^'\n]*(?:'[^'\n]*'[^'\n]*)*?)'(?=\s*[),+\]])|"((?:SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*)"/g)) {
    let sql = match[1] ?? match[2]
    // Multi-row INSERTs build their VALUES list at run time; give them one row of placeholders.
    const insert = /^INSERT INTO \w+ \(([^)]+)\) VALUES\s*$/.exec(sql)
    if (insert) sql += '(' + insert[1].split(',').map(() => '?').join(', ') + ')'
    statements.push({ file: 'dist/server/index.js', sql })
  }
  // The album artwork queries splice in a shared column list.
  const columns = /(?:const|var) albumArtworkColumns = ["']([^"']+)["']/.exec(source)[1]
  statements.push({ file: 'dist/server/index.js', sql: `SELECT ${columns} FROM album_artwork` })
  return statements
}

// Preparing a statement makes SQLite resolve every table and column it names. Strings that are only
// fragments of a query (joined to more SQL at run time) fail with a syntax error and are skipped, but
// an unknown table or column fails the test.
function assertWorkerSqlMatches(db) {
  const missing = []
  let checked = 0
  for (const { file, sql } of workerSql()) {
    try {
      db.prepare(sql)
      checked += 1
    } catch (error) {
      if (/no such (table|column)/.test(error.message)) missing.push(`${file}: ${error.message} in ${sql}`)
    }
  }
  assert.deepEqual(missing, [])
  assert.ok(checked >= 85, `only ${checked} Worker SQL statements could be checked`)
  return checked
}

function legacyDatabase(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(runtimeDdl)
  return db
}

test('every migration applies in order to an empty database, and the Worker SQL matches the result', () => {
  const db = new DatabaseSync(':memory:')
  for (const name of migrations) applyMigration(db, name)
  assert.deepEqual(pendingMigrations(db), [])
  assert.ok(schemaOf(db).release_metadata, '0012 creates release_metadata')
  assertWorkerSqlMatches(db)
})

test('0001-0012 build the same tables and columns as the old runtime DDL, plus the new indexes', () => {
  const migrated = new DatabaseSync(':memory:')
  for (const name of baselineEra) applyMigration(migrated, name)
  const legacy = legacyDatabase()
  assert.deepEqual(schemaOf(migrated), schemaOf(legacy))
  const legacyIndexes = indexesOf(legacy)
  assert.deepEqual(legacyIndexes.filter((name) => !indexesOf(migrated).includes(name)), [])
  assert.deepEqual(indexesOf(migrated).filter((name) => !legacyIndexes.includes(name)), [
    'idx_album_artwork_uploads_album', 'idx_catalogue_oauth_states_expires', 'idx_playlist_shares_owner', 'idx_recovery_items_username_updated',
  ])
})

test('0012 only uses IF NOT EXISTS, so it is a no-op for objects the runtime DDL created', () => {
  const statements = readFileSync(join(drizzle, '0012_schema_catch_up.sql'), 'utf8').split('--> statement-breakpoint').map((part) => part.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)
  for (const statement of statements) assert.match(statement, /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /, statement)
  assert.doesNotMatch(readFileSync(join(drizzle, '0012_schema_catch_up.sql'), 'utf8'), /\bALTER TABLE\b/)
})

// Stub wrangler: runs `d1 execute` and `d1 migrations list` against the SQLite file in STUB_DB and
// logs every call. `whoami` (from backup.sh) reports a logged-in account.
const wranglerStub = `#!/usr/bin/env node
const { appendFileSync, readdirSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, 'wrangler ' + args.join(' ') + '\\n')
if (args[0] === 'whoami') { console.log('You are logged in with an API Token.'); process.exit(0) }
const db = new DatabaseSync(process.env.STUB_DB)
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
if (args[0] === 'd1' && args[1] === 'execute') {
  const sql = option('--command')
  if (args.includes('--json')) console.log(JSON.stringify([{ results: db.prepare(sql).all(), success: true, meta: {} }]))
  else db.exec(sql)
} else if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get()
  const applied = table ? db.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name) : []
  const pending = readdirSync('drizzle').filter((name) => name.endsWith('.sql')).sort().filter((name) => !applied.includes(name))
  console.log(pending.length ? 'Migrations to be applied: ' + pending.join(' ') : 'No migrations to apply!')
} else {
  console.error('unexpected wrangler call: ' + args.join(' '))
  process.exit(1)
}
`

function setup(prepare) {
  const root = mkdtempSync(join(tmpdir(), 'tomify-d1-baseline-'))
  const bin = join(root, 'bin')
  const state = join(root, 'state', 'tomify-recovery')
  for (const dir of [bin, state]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(bin, 'wrangler'), wranglerStub)
  chmodSync(join(bin, 'wrangler'), 0o755)
  const dbPath = join(root, 'd1.sqlite')
  const db = new DatabaseSync(dbPath)
  prepare?.(db)
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_DB: dbPath, STUB_LOG: log, NODE_NO_WARNINGS: '1', BACKUP_DIR: join(root, 'backups'), TOMIFY_RECOVERY_STATE_DIR: state }
  delete env.WRANGLER
  const run = (...args) => spawnSync('bash', [baselineScript, ...args], { env, encoding: 'utf8' })
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return { db, run, calls, root }
}

const legacy = (db) => db.exec(runtimeDdl)

test('baseline dry run on a database built by the old runtime DDL plans 0001-0011 and leaves 0012 onwards pending', { skip }, () => {
  const { db, run, calls } = setup(legacy)
  const before = schemaOf(db)
  const result = run('--local', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  for (const name of migrations.slice(0, 11)) assert.match(result.stdout, new RegExp(`INSERT OR IGNORE INTO "d1_migrations" \\(name\\) VALUES \\('${name}'\\);`))
  assert.doesNotMatch(result.stdout, /VALUES \('0012/)
  assert.match(result.stdout, new RegExp(`\\[dry-run\\] pending migrations afterwards: ${migrations.slice(11).join(' ').replace(/\./g, '\\.')}\\n`))
  assert.deepEqual(appliedMigrations(db), [])
  assert.deepEqual(schemaOf(db), before)
  assert.ok(calls().every((call) => call.includes(' --json ')), 'a dry run only reads')
})

test('baseline records 0001-0011 the way wrangler does, then 0012 onwards apply and the Worker SQL matches', { skip }, () => {
  // A production database whose album artwork upload and live playback routes were never used.
  const { db, run } = setup((database) => { legacy(database); database.exec('DROP TABLE album_artwork_uploads; DROP TABLE live_playback; DROP TABLE live_playback_devices') })
  const result = run('--local')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(appliedMigrations(db), migrations.slice(0, 11))
  assert.deepEqual(pendingMigrations(db), migrations.slice(11))
  assert.match(result.stdout, /Migrations to be applied: 0012_schema_catch_up\.sql/)
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'd1_migrations'").get().sql, wranglerMigrationsTable.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE').replace(/;$/, ''))

  for (const name of migrations.slice(11)) applyMigration(db, name)
  assert.deepEqual(pendingMigrations(db), [])
  const fresh = new DatabaseSync(':memory:')
  for (const name of migrations) applyMigration(fresh, name)
  assert.deepEqual(schemaOf(db), schemaOf(fresh))
  assert.deepEqual(indexesOf(db), indexesOf(fresh))
  assertWorkerSqlMatches(db)

  const again = run('--local')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already baselined/)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get().count, migrations.length)
})

test('remote baseline backs up first, and a dry run passes --dry-run to the backup', { skip }, () => {
  const { run, calls } = setup(legacy)
  const result = run('--remote', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\] would run: wrangler d1 export tomify-metadata --remote/)
  assert.equal(calls()[0], 'wrangler whoami')
  assert.ok(calls().slice(1).every((call) => call.startsWith('wrangler d1 execute tomify-metadata --remote --json')), calls().join('\n'))
})

test('remote baseline stops before touching D1 when the backup fails', { skip }, () => {
  const { db, run, calls, root } = setup(legacy)
  const result = spawnSync('bash', [baselineScript, '--remote'], { env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, STUB_DB: join(root, 'd1.sqlite'), STUB_LOG: join(root, 'calls.log'), TOMIFY_RECOVERY_STATE_DIR: join(root, 'no-such-dir') }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /backup\.sh failed, so nothing was changed/)
  assert.deepEqual(calls(), [])
  assert.deepEqual(appliedMigrations(db), [])
})

test('baseline refuses a database the old Worker did not build', { skip }, () => {
  const empty = setup()
  const result = empty.run('--local')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /has no Tomify tables.*wrangler d1 migrations apply/)

  const partial = setup((db) => db.exec('CREATE TABLE recovery_items (id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL, metadata_resolution_json TEXT, artwork_resolution_json TEXT, source_json TEXT)'))
  const refused = partial.run('--local')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /recovery_items has no playback_json column/)
  assert.deepEqual(appliedMigrations(partial.db), [])
})

test('baseline needs exactly one of --remote and --local', { skip }, () => {
  const { run, calls } = setup(legacy)
  assert.equal(run().status, 2)
  assert.equal(run('--dry-run').status, 2)
  assert.equal(run('--remote', '--local').status, 1)
  assert.deepEqual(calls(), [])
})
