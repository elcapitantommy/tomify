import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(url))
    else if (/\.ts$/.test(entry.name)) files.push(url)
  }
  return files
}

test('the deployed Worker stays below 150 KB and contains no hard-coded Navidrome REST origin', async () => {
  const output = await mkdtemp(join(tmpdir(), 'tomify-worker-'))
  const windows = process.platform === 'win32'
  try {
    const result = spawnSync(windows ? process.execPath : 'pnpm', windows
      ? [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'deploy', '--dry-run', '--outdir', output]
      : ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', output], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const bundle = join(output, 'index.js')
    assert.ok((await stat(bundle)).size <= 150 * 1024, `minified Worker is ${(await stat(bundle)).size} bytes`)
    assert.doesNotMatch(await readFile(bundle, 'utf8'), /https:\/\/tomify\.tomdixon\.uk\/rest/)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('Worker env reads, Env typing and the architecture binding table stay in sync', async () => {
  const sources = await sourceFiles(new URL('../worker/', import.meta.url))
  const readNames = new Set()
  for (const file of sources) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/\benv\??\.([A-Z_]+)/g)) readNames.add(match[1])
  }

  const envSource = await readFile(new URL('../worker/env.ts', import.meta.url), 'utf8')
  const envBlock = /export interface Env \{([\s\S]*?)\n\}/.exec(envSource)?.[1] || ''
  const typedNames = new Set([...envBlock.matchAll(/^\s*([A-Z_]+)\??:/gm)].map((match) => match[1]))
  assert.deepEqual([...typedNames].sort(), [...readNames].sort())

  const architecture = await readFile(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8')
  const table = architecture.slice(architecture.indexOf('<!-- worker-configuration:start -->'), architecture.indexOf('<!-- worker-configuration:end -->'))
  assert.ok(table, 'the Worker configuration table is missing')
  const documentedNames = new Set([...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1]))
  for (const name of readNames) assert.ok(documentedNames.has(name), `${name} is missing from the Worker configuration table`)
})

test('build and route tests use the pinned Wrangler binary', async () => {
  const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const routes = await readFile(new URL('./build-routing.node-test.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(packageJson + routes, /npx(?: --yes)? wrangler(?:@4)?/)
  assert.match(packageJson, /"wrangler": "4\.86\.0"/)
  assert.match(packageJson + routes, /pnpm exec wrangler/)
})
