#!/usr/bin/env node
// Adds BPM, genre and mood tags to a library that is already there (imports get them as they land; see
// track-style.mjs). Walks the folders given, skipping hidden ones such as .tomify-source, and tags every file that
// is missing any of the three. Safe to stop and re-run: files that already have their tags, or were looked up
// before without a result, are skipped. Run it with the agent's environment so it uses the same settings:
//   set -a; . /etc/tomify/recovery-agent.env; set +a
//   node /opt/tomify/current/recovery-agent/style-backfill.mjs [--dry-run] [--recheck] [--limit N] /srv/music
import { readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStyleTagger, STYLE_EXTENSIONS } from './track-style.mjs'

export async function* styleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* styleFiles(path)
    else if (entry.isFile() && STYLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield path
  }
}

export function parseArguments(argv) {
  const options = { dryRun: false, recheck: false, limit: Infinity, roots: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--dry-run') options.dryRun = true
    else if (value === '--recheck') options.recheck = true
    else if (value === '--limit') options.limit = Number(argv[++index])
    else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`)
    else options.roots.push(resolve(value))
  }
  if (!options.roots.length) throw new Error('Name at least one library folder, for example /srv/music.')
  if (!(options.limit > 0)) throw new Error('--limit needs a positive number.')
  return options
}

export async function backfillStyle(options, { tagger = createStyleTagger(), print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const totals = { checked: 0, tagged: 0, failed: 0 }
  for (const root of options.roots) {
    for await (const file of styleFiles(root)) {
      if (totals.checked >= options.limit) return totals
      totals.checked += 1
      try {
        const added = await tagger.tagFile(file, options)
        if (!added) continue
        const parts = [added.bpm && `${added.bpm} BPM`, added.genres.join('; '), added.moods.join('; ')].filter(Boolean)
        if (parts.length) { totals.tagged += 1; print(`${options.dryRun ? 'would tag' : 'tagged'} ${file}: ${parts.join(', ')}`) }
      } catch (error) {
        totals.failed += 1
        print(`failed ${file}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }
  return totals
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (!process.env.BPM_PATH && !/^(1|on|true|yes)$/i.test(process.env.STYLE_LOOKUP || '')) throw new Error('Set BPM_PATH and/or STYLE_LOOKUP=on first (see docs/RECOVERY.md "BPM, genre and mood tags").')
    const totals = await backfillStyle(options)
    process.stdout.write(`${totals.checked} files checked, ${totals.tagged} ${options.dryRun ? 'would be ' : ''}tagged, ${totals.failed} failed.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
