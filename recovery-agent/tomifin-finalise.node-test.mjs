import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTomifinController, tomifinConfig } from './tomifin.mjs'
import { readyForFinalisation, stagedContent } from './tomifin-finalise.mjs'

// Finishing torrents that qBittorrent completed but left in their staging folder (tomifin-finalise.mjs), against
// real folders in a temporary directory and a qBittorrent stand-in.

const START = Date.parse('2026-10-24T12:00:00Z')
let counter = 0
const jobId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
const hashFor = (id) => id.replace(/-/g, '').padEnd(40, 'a').slice(0, 40)

async function setup({ client: makeClient = fakeClient, intervalMs = 60 * 60_000 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tomifin-finalise-')))
  const family = join(root, 'family')
  const privateDir = join(root, 'private')
  const stateRoot = join(root, 'state')
  await Promise.all([mkdir(family), mkdir(privateDir), mkdir(stateRoot)])
  const config = tomifinConfig({ TOMIFY_TOMIFIN_FAMILY_DIR: family, TOMIFY_TOMIFIN_PRIVATE_DIR: privateDir }, { torrentAvailable: true })
  const client = makeClient()
  const clock = { value: START }
  const logs = []
  const refreshes = []
  const controller = createTomifinController({ config, client, stateRoot, now: () => clock.value, log: (line) => logs.push(line), intervalMs, refreshLibrary: async () => { refreshes.push(clock.value) } })
  const env = { root, family, private: privateDir, stateRoot, config, client, clock, logs, refreshes, controller }
  // A persisted Tomifin job (as on the box) with its staging folder, created an hour ago.
  env.job = async (destination = 'private', extra = {}) => {
    const id = jobId()
    const job = { id, version: 1, downloader: 'qbittorrent', createdAt: new Date(START - 60 * 60_000).toISOString(), destination, title: 'Big Buck Bunny', source: 'test', size: null, infoHash: hashFor(id), linkType: 'magnet', resultId: 'r'.repeat(64), ...extra }
    await mkdir(join(stateRoot, 'tomifin'), { recursive: true })
    await writeFile(join(stateRoot, 'tomifin', `${id}.json`), JSON.stringify(job))
    const library = destination === 'private' ? privateDir : family
    const staging = join(library, '.tomifin-incomplete', id)
    await mkdir(staging, { recursive: true })
    return { id, staging, library, hash: hashFor(id) }
  }
  // The torrent qBittorrent reports for a job.
  env.torrent = (job, fields = {}) => {
    const torrent = { hash: job.hash, name: 'Big Buck Bunny', tags: `tomifin-${job.id}`, category: job.library === privateDir ? 'tomifin-private' : 'tomifin-family', state: 'stalledUP', progress: 1, amount_left: 0, total_size: 11, save_path: job.library, download_path: job.staging, content_path: join(job.staging, 'Big Buck Bunny'), ...fields }
    client.torrents.push(torrent)
    return torrent
  }
  env.saved = async (id) => JSON.parse(await readFile(join(stateRoot, 'tomifin', `${id}.json`), 'utf8'))
  env.view = async (id) => (await controller.list()).jobs.find((job) => job.id === id)
  return env
}

function fakeClient() {
  const calls = []
  const torrents = []
  return {
    calls, torrents,
    async info(value) { calls.push(['info', value]); return torrents.find((torrent) => torrent.tags.split(',').includes(value)) || null },
    async list(category) { calls.push(['list', category]); return torrents.filter((torrent) => torrent.category === category).map((torrent) => ({ ...torrent })) },
    async pause(value) { calls.push(['pause', value]) },
    async remove(value, deleteFiles) { calls.push(['remove', value, deleteFiles]); const index = torrents.findIndex((torrent) => torrent.hash === value); if (index >= 0) torrents.splice(index, 1) },
  }
}

const removes = (client) => client.calls.filter(([name]) => name === 'remove')
async function exists(path) { return Boolean(await stat(path).catch(() => null)) }

// A finished film as qBittorrent's Subfolder layout saves it: a folder named after the torrent with the video inside.
async function filmFolder(staging, name = 'Big Buck Bunny') {
  await mkdir(join(staging, name, 'Subs'), { recursive: true })
  await writeFile(join(staging, name, 'Big Buck Bunny.mkv'), 'video-bytes')
  await writeFile(join(staging, name, 'Subs', 'en.srt'), 'subs')
}

test('readyForFinalisation accepts only finished states at exactly 100 %', () => {
  for (const state of ['uploading', 'stalledUP', 'queuedUP', 'stoppedUP', 'pausedUP', 'forcedUP', 'checkingUP']) assert.equal(readyForFinalisation({ state, progress: 1 }), true, state)
  for (const torrent of [{ state: 'stalledDL', progress: 0.759 }, { state: 'stalledDL', progress: 1 }, { state: 'uploading', progress: 0.999 }, { state: 'stalledUP', progress: 1, amount_left: 4096 }, { state: 'moving', progress: 1 }, { state: 'checkingDL', progress: 1 }, { state: 'error', progress: 1 }, null]) {
    assert.equal(readyForFinalisation(torrent), false, JSON.stringify(torrent))
  }
})

for (const state of ['uploading', 'stalledUP', 'queuedUP', 'stoppedUP']) {
  test(`a torrent ${state} at 100 % in its staging folder is moved into the library and taken out of qBittorrent`, async () => {
    const env = await setup()
    const job = await env.job('private')
    await filmFolder(job.staging)
    env.torrent(job, { state })
    await env.controller.observe()
    assert.deepEqual(removes(env.client), [['remove', job.hash, false]], 'removed without deleting files')
    assert.equal(await readFile(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv'), 'utf8'), 'video-bytes')
    assert.equal(await readFile(join(env.private, 'Big Buck Bunny', 'Subs', 'en.srt'), 'utf8'), 'subs')
    const saved = await env.saved(job.id)
    assert.equal(saved.finalise.state, 'published')
    assert.match(saved.completedAt, /^2026-/)
    const view = await env.view(job.id)
    assert.deepEqual([view.status, view.progress, view.message], ['completed', 100, 'In the library'])
    // The now-empty staging folder of this known job is removed; nothing else in .tomifin-incomplete.
    assert.equal(await exists(job.staging), false)
    assert.deepEqual(await readdir(join(env.private, '.tomifin-incomplete')), [])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(env.refreshes.length, 1, 'Jellyfin is asked to scan')
  })
}

test('genuinely partial torrents (stalledDL at 75.9 % and 13.8 %) are left untouched', async () => {
  const env = await setup()
  const partial = []
  for (const progress of [0.759, 0.138]) {
    const job = await env.job('private')
    await filmFolder(job.staging)
    await writeFile(join(job.staging, 'Big Buck Bunny', 'part.mkv.!qB'), 'partial')
    env.torrent(job, { state: 'stalledDL', progress, amount_left: 1000 })
    partial.push(job)
  }
  for (let round = 0; round < 3; round += 1) await env.controller.observe()
  assert.deepEqual(removes(env.client), [])
  for (const job of partial) {
    assert.equal(await readFile(join(job.staging, 'Big Buck Bunny', 'part.mkv.!qB'), 'utf8'), 'partial')
    assert.equal((await env.saved(job.id)).finalise, undefined)
    assert.equal((await env.view(job.id)).status, 'stalled')
  }
  assert.equal(await exists(join(env.private, 'Big Buck Bunny')), false)
})

test('a single-file torrent saved in its own subfolder (a nested content path) is moved as that folder', async () => {
  const env = await setup()
  const job = await env.job('private')
  await mkdir(join(job.staging, 'Sintel.2010.1080p'))
  await writeFile(join(job.staging, 'Sintel.2010.1080p', 'Sintel.2010.1080p.mkv'), 'sintel')
  env.torrent(job, { name: 'Sintel.2010.1080p.mkv', content_path: join(job.staging, 'Sintel.2010.1080p', 'Sintel.2010.1080p.mkv') })
  await env.controller.observe()
  assert.equal(await readFile(join(env.private, 'Sintel.2010.1080p', 'Sintel.2010.1080p.mkv'), 'utf8'), 'sintel')
  assert.equal(removes(env.client).length, 1)
  assert.equal((await env.saved(job.id)).finalise.kind, 'folder')
})

test('a single file directly in staging is hardlinked into the library without replacing anything', async () => {
  const env = await setup()
  const job = await env.job('family')
  await writeFile(join(job.staging, 'Elephants Dream.mkv'), 'dream')
  env.torrent(job, { name: 'Elephants Dream.mkv', content_path: join(job.staging, 'Elephants Dream.mkv') })
  await env.controller.observe()
  assert.equal(await readFile(join(env.family, 'Elephants Dream.mkv'), 'utf8'), 'dream')
  assert.equal(await exists(join(job.staging, 'Elephants Dream.mkv')), false)
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
})

test('start-up reconciliation finishes stranded torrents straight away', async () => {
  const env = await setup({ intervalMs: 60 * 60_000 })
  const job = await env.job('private')
  await filmFolder(job.staging)
  env.torrent(job, { state: 'queuedUP' })
  const stop = env.controller.start()
  try {
    for (let i = 0; i < 200 && (await env.saved(job.id)).finalise?.state !== 'published'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  } finally { stop() }
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
  assert.equal(await exists(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true)
})

test('periodic reconciliation finishes a torrent that completes while the agent runs', async () => {
  const env = await setup({ intervalMs: 20 })
  const job = await env.job('private')
  await filmFolder(job.staging)
  const torrent = env.torrent(job, { state: 'downloading', progress: 0.5, amount_left: 100 })
  const stop = env.controller.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(removes(env.client), [], 'not while downloading')
    Object.assign(torrent, { state: 'uploading', progress: 1, amount_left: 0 })
    for (let i = 0; i < 200 && (await env.saved(job.id)).finalise?.state !== 'published'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  } finally { stop() }
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
  assert.equal(removes(env.client).length, 1)
})

test('the downloads list reconciles too, and repeated reconciliation is idempotent', async () => {
  const env = await setup()
  const job = await env.job('private')
  await filmFolder(job.staging)
  env.torrent(job)
  // The list and the regular check at the same moment: one removal, one publication.
  await Promise.all([env.controller.list(), env.controller.observe(), env.controller.list()])
  for (let round = 0; round < 3; round += 1) { await env.controller.observe(); await env.controller.list() }
  assert.equal(removes(env.client).length, 1)
  assert.deepEqual(await readdir(env.private), ['.tomifin-incomplete', 'Big Buck Bunny'])
  assert.equal(env.logs.filter((line) => /moved .* in the Private library/.test(line)).length, 1)
})

test('an interrupted finalisation is picked up again from what is on disk', async () => {
  // Interrupted after qBittorrent removal, before publication.
  const env = await setup()
  const job = await env.job('private', { finalise: { state: 'publishing', item: 'Big Buck Bunny', kind: 'folder', removedAt: new Date(START).toISOString() } })
  await filmFolder(job.staging)
  // ... and also after reserving the library name (an empty folder Tomifin made).
  await mkdir(join(env.private, 'Big Buck Bunny'))
  await env.controller.observe()
  assert.equal(await readFile(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv'), 'utf8'), 'video-bytes')
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
  // Interrupted after publication, before the record was updated.
  const done = await env.job('private', { finalise: { state: 'publishing', item: 'Sintel', kind: 'folder' } })
  await mkdir(join(env.private, 'Sintel'))
  await writeFile(join(env.private, 'Sintel', 'Sintel.mkv'), 'published')
  await env.controller.observe()
  assert.equal((await env.saved(done.id)).finalise.state, 'published')
  assert.equal(await readFile(join(env.private, 'Sintel', 'Sintel.mkv'), 'utf8'), 'published')
  assert.deepEqual(removes(env.client), [])
})

test('an existing library item is never replaced: the torrent keeps seeding until the name is free', async () => {
  const env = await setup()
  const job = await env.job('private')
  await filmFolder(job.staging)
  await mkdir(join(env.private, 'Big Buck Bunny'))
  await writeFile(join(env.private, 'Big Buck Bunny', 'mine.mkv'), 'already here')
  env.torrent(job)
  await env.controller.observe()
  assert.deepEqual(removes(env.client), [])
  assert.deepEqual(await readdir(join(env.private, 'Big Buck Bunny')), ['mine.mkv'])
  assert.equal(await exists(join(job.staging, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true)
  const view = await env.view(job.id)
  assert.equal(view.status, 'failed')
  assert.match(view.message, /already has something called "Big Buck Bunny".*keeps seeding/)
  assert.deepEqual([view.canRetry, view.keepsFilesOnCancel], [true, true])
  // Still held on the next checks (with backoff), and logged once rather than every time.
  for (let round = 0; round < 3; round += 1) { env.clock.value += 60 * 60_000; await env.controller.observe() }
  assert.equal(env.logs.filter((line) => /already has something/.test(line)).length, 1)
  // Once the name is free, Retry finishes it.
  await rm(join(env.private, 'Big Buck Bunny'), { recursive: true })
  const { job: retried } = await env.controller.retry({ id: job.id })
  assert.equal(retried.status, 'completed')
  assert.equal(await readFile(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv'), 'utf8'), 'video-bytes')
})

test('unsafe or foreign content paths are never published', async () => {
  const env = await setup()
  const outside = join(env.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.mkv'), 'not tomifin')
  const other = await env.job('private')
  await filmFolder(other.staging)
  const cases = [
    ['another job\'s staging folder', (job) => ({ content_path: join(other.staging, 'Big Buck Bunny') })],
    ['a folder outside the library', () => ({ content_path: join(outside, 'secret.mkv') })],
    ['traversal out of staging', (job) => ({ content_path: `${job.staging}/../${other.id}/Big Buck Bunny` })],
    ['the staging folder itself', (job) => ({ content_path: job.staging })],
    ['a hidden top-level name', (job) => ({ content_path: join(job.staging, '.hidden') })],
    ['the wrong category', () => ({ category: 'recovery' })],
    ['the other library\'s category', () => ({ category: 'tomifin-family' })],
    ['a missing tag', () => ({ tags: 'tomifin-00000000-0000-4000-8000-999999999999' })],
    ['a foreign download folder', () => ({ download_path: outside })],
  ]
  for (const [label, fields] of cases) {
    const job = await env.job('private')
    await filmFolder(job.staging)
    await mkdir(join(job.staging, '.hidden'))
    await writeFile(join(job.staging, '.hidden', 'x.mkv'), 'x')
    const torrent = env.torrent(job, fields(job))
    // A torrent whose tag or category is wrong is not this job's torrent at all, so it is checked directly too.
    if (/category|a missing tag/.test(label)) assert.throws(() => stagedContent(torrent, env.config.destinations.private, job.id), /category|tag/, label)
    await env.controller.observe()
    assert.deepEqual(removes(env.client), [], label)
    assert.equal(await exists(join(job.staging, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true, label)
    env.client.torrents.splice(0)
  }
  assert.deepEqual((await readdir(env.private)).sort(), ['.tomifin-incomplete'])
  assert.equal(await readFile(join(outside, 'secret.mkv'), 'utf8'), 'not tomifin')
})

test('symlinks in or around the staging folder are refused', async () => {
  const env = await setup()
  const outside = join(env.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'passwd'), 'root')
  // A symlink inside the download.
  const inside = await env.job('private')
  await filmFolder(inside.staging)
  await symlink(join(outside, 'passwd'), join(inside.staging, 'Big Buck Bunny', 'link.mkv'))
  env.torrent(inside)
  // The content itself is a symlink.
  const linked = await env.job('private')
  await symlink(outside, join(linked.staging, 'Big Buck Bunny'))
  env.torrent(linked)
  // The staging folder is a symlink to somewhere else.
  const swapped = await env.job('private')
  await rm(swapped.staging, { recursive: true })
  await symlink(outside, swapped.staging)
  env.torrent(swapped, { content_path: join(swapped.staging, 'passwd') })
  await env.controller.observe()
  assert.deepEqual(removes(env.client), [])
  assert.deepEqual((await readdir(env.private)).sort(), ['.tomifin-incomplete'])
  for (const job of [inside, linked, swapped]) assert.equal((await env.saved(job.id)).finalise.state, 'held')
  assert.match((await env.view(inside.id)).message, /symbolic link/)
})

test('a failed qBittorrent removal keeps everything in staging and is tried again', async () => {
  let failures = 1
  const env = await setup({ client: () => { const client = fakeClient(); const remove = client.remove.bind(client); client.remove = async (hash, deleteFiles) => { client.calls.push(['remove', hash, deleteFiles]); if (failures-- > 0) throw new Error('qBittorrent delete returned HTTP 500.'); client.calls.pop(); return remove(hash, deleteFiles) }; return client } })
  const job = await env.job('private')
  await filmFolder(job.staging)
  env.torrent(job)
  await env.controller.observe()
  assert.equal(env.client.torrents.length, 1)
  assert.equal(await exists(join(job.staging, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true)
  assert.equal(await exists(join(env.private, 'Big Buck Bunny')), false)
  const view = await env.view(job.id)
  assert.equal((await env.saved(job.id)).finalise.state, 'remove-failed')
  assert.match(view.message, /waiting to take it out of qBittorrent: qBittorrent delete returned HTTP 500/)
  assert.equal(view.canRetry, true)
  // Waits for its backoff, then finishes.
  env.clock.value += 60_000
  await env.controller.observe()
  assert.equal(env.client.torrents.length, 0)
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
  assert.equal(await exists(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true)
})

test('a publication that fails after qBittorrent removal keeps the data, says so and recovers', async () => {
  let env
  env = await setup({ client: () => {
    const client = fakeClient()
    const remove = client.remove.bind(client)
    // Something of the same name appears in the library just as the torrent is taken out of qBittorrent.
    client.remove = async (hash, deleteFiles) => { await remove(hash, deleteFiles); await mkdir(join(env.private, 'Big Buck Bunny')); await writeFile(join(env.private, 'Big Buck Bunny', 'other.mkv'), 'other') }
    return client
  } })
  const job = await env.job('private')
  await filmFolder(job.staging)
  env.torrent(job)
  await env.controller.observe()
  assert.equal(env.client.torrents.length, 0)
  assert.equal((await env.saved(job.id)).finalise.state, 'publish-failed')
  assert.deepEqual(await readdir(join(env.private, 'Big Buck Bunny')), ['other.mkv'], 'not replaced')
  assert.equal(await readFile(join(job.staging, 'Big Buck Bunny', 'Big Buck Bunny.mkv'), 'utf8'), 'video-bytes', 'data kept in staging')
  const view = await env.view(job.id)
  assert.equal(view.status, 'failed')
  assert.match(view.message, /out of qBittorrent, but not yet moved into Private.*kept in its staging folder/)
  // The staging folder is not cleaned while it holds the unpublished download.
  env.clock.value += 24 * 60 * 60_000
  await env.controller.observe()
  assert.equal(await exists(join(job.staging, 'Big Buck Bunny', 'Big Buck Bunny.mkv')), true)
  // Once the clash is dealt with, the next attempt publishes it.
  await rm(join(env.private, 'Big Buck Bunny'), { recursive: true })
  env.clock.value += 24 * 60 * 60_000
  await env.controller.observe()
  assert.equal((await env.saved(job.id)).finalise.state, 'published')
  assert.equal(await readFile(join(env.private, 'Big Buck Bunny', 'Big Buck Bunny.mkv'), 'utf8'), 'video-bytes')
})

test('only empty staging folders of known jobs that qBittorrent no longer has are removed', async () => {
  const env = await setup()
  const staging = join(env.private, '.tomifin-incomplete')
  // Known, finished long ago, empty (with an empty subfolder): removed.
  const empty = await env.job('private', { completedAt: new Date(START - 30 * 60_000).toISOString() })
  await mkdir(join(empty.staging, 'Leftover'))
  // Known, empty, but its torrent is still in qBittorrent: kept.
  const active = await env.job('private')
  env.torrent(active, { state: 'metaDL', progress: 0, amount_left: 100 })
  // Known, no torrent, but holds a file: kept.
  const holding = await env.job('private')
  await writeFile(join(holding.staging, 'partial.mkv'), 'partial')
  // Known, empty, just queued (the torrent may not be listed yet): kept.
  const fresh = await env.job('private', { createdAt: new Date(START).toISOString() })
  // Unknown folders (no job record), empty or not: never touched.
  const unknownEmpty = join(staging, '11111111-1111-4111-8111-111111111111')
  const unknownFull = join(staging, '22222222-2222-4222-8222-222222222222')
  await mkdir(unknownEmpty)
  await mkdir(unknownFull)
  await writeFile(join(unknownFull, 'x.mkv'), 'x')
  await env.controller.observe()
  assert.equal(await exists(empty.staging), false)
  for (const path of [active.staging, holding.staging, fresh.staging, unknownEmpty, unknownFull]) assert.equal(await exists(path), true, path)
  assert.equal(await readFile(join(holding.staging, 'partial.mkv'), 'utf8'), 'partial')
  assert.equal((await env.saved(empty.id)).stagingClear, true)
  assert.deepEqual(removes(env.client), [])
})
