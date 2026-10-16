import test from 'node:test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupCompletedDownload, commitCoverFile, commitTrackFiles } from './commit.mjs'

async function missing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT')
}

test('YouTube-style and Internet Archive-style cover commits keep an existing cover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-cover-commit-test-'))
  try {
    const replacement = join(root, 'replacement.jpg')
    await writeFile(replacement, 'new cover')
    for (const source of ['youtube', 'internet-archive']) {
      const release = join(root, source)
      const cover = join(release, 'cover.jpg')
      await mkdir(release)
      await writeFile(cover, `${source} existing cover`)
      assert.deepEqual(await commitCoverFile(replacement, cover), { created: false, existingCoverKept: true })
      assert.equal(await readFile(cover, 'utf8'), `${source} existing cover`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failure after staging the original leaves no new track files or hidden temporaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-track-commit-test-'))
  try {
    const originalSource = join(root, 'source.flac')
    const derivativeSource = join(root, 'tagged.flac')
    const destination = join(root, 'album')
    const sourceDirectory = join(destination, '.tomify-source')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(originalSource, 'original')
    await writeFile(derivativeSource, 'derivative')
    const originalPath = join(sourceDirectory, 'track.flac')
    const derivativePath = join(destination, 'track.flac')
    let copies = 0
    const failingCopy = async (...args) => {
      copies += 1
      if (copies === 2) throw new Error('injected derivative staging failure')
      return copyFile(...args)
    }

    await assert.rejects(commitTrackFiles({ originalSource, derivativeSource, originalPath, derivativePath }, { copyFile: failingCopy }), /injected derivative staging failure/)
    await missing(originalPath)
    await missing(derivativePath)
    assert.deepEqual((await readdir(destination)).filter((name) => name.includes('tomify-tmp')), [])
    assert.deepEqual((await readdir(sourceDirectory)).filter((name) => name.includes('tomify-tmp')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an existing final file is never replaced and a partial commit is rolled back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-exclusive-commit-test-'))
  try {
    const originalSource = join(root, 'source.flac')
    const derivativeSource = join(root, 'tagged.flac')
    const originalPath = join(root, 'original.flac')
    const derivativePath = join(root, 'final.flac')
    await writeFile(originalSource, 'original')
    await writeFile(derivativeSource, 'new derivative')
    await writeFile(derivativePath, 'existing derivative')
    await assert.rejects(commitTrackFiles({ originalSource, derivativeSource, originalPath, derivativePath }), (error) => error?.code === 'EEXIST')
    await missing(originalPath)
    assert.equal(await readFile(derivativePath, 'utf8'), 'existing derivative')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SABnzbd cleanup deletes only a completed folder inside the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomify-cleanup-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'tomify-cleanup-outside-'))
  try {
    const completed = join(root, 'album-job')
    await mkdir(completed)
    await writeFile(join(completed, 'track.flac'), 'audio')
    assert.equal(await cleanupCompletedDownload(completed, root), true)
    await missing(completed)

    assert.equal(await cleanupCompletedDownload(outside, root), false)
    await access(outside)
    assert.equal(await cleanupCompletedDownload(root, root), false)
    await access(root)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
