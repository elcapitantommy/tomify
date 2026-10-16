import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(url))
    else if (/\.(?:ts|mjs)$/.test(entry.name)) files.push(url)
  }
  return files
}

test('the Worker uses normal modules without generated WorkerSource strings', async () => {
  const files = [
    ...await sourceFiles(new URL('../worker/', import.meta.url)),
    new URL('./catalogue-import.mjs', import.meta.url),
    new URL('./recovery-artwork.mjs', import.meta.url),
    new URL('./recovery-metadata.mjs', import.meta.url),
  ]
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /WorkerSource|\.map\(\(fn\) => fn\.toString\(\)\)/, file.pathname)
  }
})
