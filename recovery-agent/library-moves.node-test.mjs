import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLibraryMoves } from './library-moves.mjs'

async function libraries() {
  const base = await mkdtemp(join(tmpdir(), 'tomify-moves-test-'))
  const roots = { masterRoot: join(base, 'music'), recoveryRoot: join(base, 'recovery'), stateRoot: join(base, 'state') }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  return { base, ...roots }
}

async function put(path, contents = 'audio') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

const gone = (path) => assert.rejects(stat(path), { code: 'ENOENT' })

test('plans a merge without touching any file, then applies and undoes it', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'Kinks', 'Something Else', '01.flac')
  const master = join(roots.masterRoot, 'Kinks', 'Something Else (2)', '01.flac')
  const recovered = join(roots.recoveryRoot, 'Kinks', 'Something Else', '01.flac')
  const original = join(roots.recoveryRoot, 'Kinks', 'Something Else', '.tomify-source', '01.webm')
  await put(keep, 'kept')
  await put(master, 'master copy')
  await put(recovered, 'recovered')
  await put(`${recovered}.tomify.json`, JSON.stringify({ sourceAudio: { path: original } }))
  await put(original, 'original')
  const moves = createLibraryMoves(roots)
  const body = { kind: 'merge', keep, paths: [keep, master, recovered], label: 'The Kinks — Waterloo Sunset' }

  const plan = await moves.plan(body)
  const duplicates = join(roots.masterRoot, '_Duplicates')
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to]), [
    [master, join(duplicates, 'Kinks', 'Something Else (2)', '01.flac')],
    [recovered, join(duplicates, 'recovery', 'Kinks', 'Something Else', '01.flac')],
    [`${recovered}.tomify.json`, join(duplicates, 'recovery', 'Kinks', 'Something Else', '01.flac.tomify.json')],
    [original, join(duplicates, 'recovery', 'Kinks', 'Something Else', '.tomify-source', '01.webm')],
  ])
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.sizes[master], 'master copy'.length)
  assert.equal(await readFile(master, 'utf8'), 'master copy')
  await gone(duplicates)

  const { journal } = await moves.apply(body)
  assert.equal(journal.status, 'applied')
  assert.equal(await readFile(keep, 'utf8'), 'kept')
  await gone(master)
  await gone(recovered)
  assert.equal(await readFile(join(duplicates, 'Kinks', 'Something Else (2)', '01.flac'), 'utf8'), 'master copy')
  assert.equal((await stat(join(duplicates, '.ndignore'))).size, 0)
  const saved = JSON.parse(await readFile(join(roots.stateRoot, 'library-moves', `${journal.id}.json`), 'utf8'))
  assert.equal(saved.status, 'applied')
  assert.equal(saved.moves.length, 4)
  assert.deepEqual((await moves.list()).moves.map((item) => [item.id, item.status]), [[journal.id, 'applied']])

  await moves.undo({ id: journal.id })
  assert.equal(await readFile(master, 'utf8'), 'master copy')
  assert.equal(await readFile(recovered, 'utf8'), 'recovered')
  assert.equal(await readFile(original, 'utf8'), 'original')
  assert.equal((await moves.list()).moves[0].status, 'undone')
  await assert.rejects(moves.undo({ id: journal.id }), /Only an applied library move/)
})

test('promotes a Recovery copy into the master path and keeps the master in _Duplicates', async () => {
  const roots = await libraries()
  const master = join(roots.masterRoot, 'ELO', 'Out of the Blue', '05 Mr. Blue Sky.mp3')
  const recovered = join(roots.recoveryRoot, 'ELO', 'Out of the Blue', '05 - Mr. Blue Sky.flac')
  await put(master, 'lossy')
  await put(recovered, 'lossless')
  await put(`${recovered}.tomify.json`, '{}')
  const moves = createLibraryMoves(roots)
  const body = { kind: 'promote', master, recovery: recovered }
  const target = join(roots.masterRoot, 'ELO', 'Out of the Blue', '05 Mr. Blue Sky.flac')
  assert.deepEqual((await moves.plan(body)).moves.map((move) => [move.from, move.to]), [
    [master, join(roots.masterRoot, '_Duplicates', 'ELO', 'Out of the Blue', '05 Mr. Blue Sky.mp3')],
    [recovered, target],
    [`${recovered}.tomify.json`, `${target}.tomify.json`],
  ])
  const { journal } = await moves.apply(body)
  assert.equal(await readFile(target, 'utf8'), 'lossless')
  await gone(master)
  await moves.undo({ id: journal.id })
  assert.equal(await readFile(master, 'utf8'), 'lossy')
  assert.equal(await readFile(recovered, 'utf8'), 'lossless')
  await gone(target)
})

test('a promotion with the same extension takes over the vacated master path', async () => {
  const roots = await libraries()
  const master = join(roots.masterRoot, 'A', 'B', '01.flac')
  const recovered = join(roots.recoveryRoot, 'A', 'B', '01.flac')
  await put(master, 'old')
  await put(recovered, 'new')
  const moves = createLibraryMoves(roots)
  const plan = await moves.plan({ kind: 'promote', master, recovery: recovered })
  assert.deepEqual(plan.conflicts, [])
  const { journal } = await moves.apply({ kind: 'promote', master, recovery: recovered })
  assert.equal(await readFile(master, 'utf8'), 'new')
  await moves.undo({ id: journal.id })
  assert.equal(await readFile(master, 'utf8'), 'old')
  assert.equal(await readFile(recovered, 'utf8'), 'new')
})

test('refuses paths outside the libraries, in reserved folders, relative, or through symbolic links', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'A', '01.flac')
  await put(keep)
  await put(join(roots.base, 'elsewhere', '01.flac'))
  await put(join(roots.masterRoot, '_Duplicates', 'A', '01.flac'))
  await put(join(roots.recoveryRoot, '.tomify-deleted', 'A', '01.flac'))
  await put(join(roots.recoveryRoot, 'A', '.tomify-source', '01.flac'))
  await symlink(join(roots.base, 'elsewhere'), join(roots.masterRoot, 'link'))
  const moves = createLibraryMoves(roots)
  const merge = (other) => moves.plan({ kind: 'merge', keep, paths: [keep, other] })
  await assert.rejects(merge(join(roots.base, 'elsewhere', '01.flac')), /not inside TOMIFY_MASTER_DIR/)
  await assert.rejects(merge(join(roots.masterRoot, '_Duplicates', 'A', '01.flac')), /keeps out of the library/)
  await assert.rejects(merge(join(roots.recoveryRoot, '.tomify-deleted', 'A', '01.flac')), /keeps out of the library/)
  await assert.rejects(merge(join(roots.recoveryRoot, 'A', '.tomify-source', '01.flac')), /keeps out of the library/)
  await assert.rejects(merge('A/01.flac'), /absolute/)
  await assert.rejects(merge(`${roots.masterRoot}/A/../A/01.flac`), /normalised/)
  await assert.rejects(merge(join(roots.masterRoot, 'link', '01.flac')), /resolves outside/)
  await assert.rejects(merge(roots.masterRoot), /not inside/)
  await assert.rejects(moves.plan({ kind: 'merge', keep: join(roots.masterRoot, 'B.flac'), paths: [keep, join(roots.masterRoot, 'C.flac')] }), /Choose the copy to keep/)
  await assert.rejects(moves.plan({ kind: 'promote', master: keep, recovery: keep }), /one Recovery file/)
  await assert.rejects(moves.undo({ id: '../../etc/passwd' }), /Invalid library move id/)
  await assert.rejects(createLibraryMoves({ ...roots, masterRoot: null }).plan({ kind: 'merge' }), /TOMIFY_MASTER_DIR is not configured/)
})

test('refuses to apply over an existing destination and leaves every file in place', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'A', 'Album', '01.flac')
  const other = join(roots.masterRoot, 'A', 'Album (1)', '01.flac')
  await put(keep)
  await put(other, 'other')
  await put(join(roots.masterRoot, '_Duplicates', 'A', 'Album (1)', '01.flac'), 'earlier duplicate')
  const moves = createLibraryMoves(roots)
  const body = { kind: 'merge', keep, paths: [keep, other] }
  assert.equal((await moves.plan(body)).conflicts.length, 1)
  await assert.rejects(moves.apply(body), /Refusing to move over existing files/)
  assert.equal(await readFile(other, 'utf8'), 'other')
  assert.deepEqual((await moves.list()).moves, [])
})

test('merges whole folders', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'Beatles', 'Past Masters I')
  const other = join(roots.masterRoot, 'Beatles', 'Past Masters 1')
  await put(join(keep, '01.flac'))
  await put(join(other, '01.flac'), 'folder copy')
  const moves = createLibraryMoves(roots)
  await moves.apply({ kind: 'merge', keep, paths: [keep, other] })
  assert.equal(await readFile(join(roots.masterRoot, '_Duplicates', 'Beatles', 'Past Masters 1', '01.flac'), 'utf8'), 'folder copy')
  await assert.rejects(moves.plan({ kind: 'merge', keep, paths: [keep, join(keep, '01.flac')] }), /inside/)
})

test('a failure part-way puts back the moves already made and records the rollback', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'A', '01.flac')
  const first = join(roots.masterRoot, 'B', '01.flac')
  const second = join(roots.masterRoot, 'C', '01.flac')
  await put(keep)
  await put(first, 'first')
  await put(second, 'second')
  let calls = 0
  const renameFile = async (from, to) => {
    calls += 1
    if (calls === 2) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    return rename(from, to)
  }
  const moves = createLibraryMoves({ ...roots, renameFile })
  await assert.rejects(moves.apply({ kind: 'merge', keep, paths: [keep, first, second] }), /different filesystems or mounts/)
  assert.equal(await readFile(first, 'utf8'), 'first')
  assert.equal(await readFile(second, 'utf8'), 'second')
  const [journal] = (await moves.list()).moves
  assert.equal(journal.status, 'rolled-back')
  assert.match(journal.error, /does not copy/)
})

test('undo refuses when a moved file was replaced at its old path', async () => {
  const roots = await libraries()
  const keep = join(roots.masterRoot, 'A', '01.flac')
  const other = join(roots.masterRoot, 'B', '01.flac')
  await put(keep)
  await put(other, 'moved')
  const moves = createLibraryMoves(roots)
  const { journal } = await moves.apply({ kind: 'merge', keep, paths: [keep, other] })
  await put(other, 'new file at the old path')
  await assert.rejects(moves.undo({ id: journal.id }), /in use again/)
  assert.equal(await readFile(other, 'utf8'), 'new file at the old path')
  assert.equal(await readFile(join(roots.masterRoot, '_Duplicates', 'B', '01.flac'), 'utf8'), 'moved')
})
