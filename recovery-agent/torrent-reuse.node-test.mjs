import test from 'node:test'
import assert from 'node:assert/strict'
import { createQbittorrentClient, findReusableTorrent } from './torrent.mjs'

const hash = '0123456789abcdef0123456789abcdef01234567'

function fakeQbittorrent(torrents) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    if (url.pathname === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc123; HttpOnly; path=/' } })
    if (url.pathname === '/api/v2/torrents/info') return Response.json(torrents.filter((torrent) => !url.searchParams.get('hashes') || torrent.hash === url.searchParams.get('hashes')))
    if (url.pathname === '/api/v2/torrents/addTags' || url.pathname === '/api/v2/torrents/removeTags') return new Response('')
    return new Response('', { status: 404 })
  }
  return { calls, client: createQbittorrentClient({ url: 'http://127.0.0.1:8081', username: 'tomify', password: 'secret', category: 'tomify' }, fetchImpl) }
}

const failedJob = { id: 'old-job', downloader: 'qbittorrent', status: 'failed', result: { resultId: 'link-result-id' }, torrent: { infoHash: hash } }

test('a link whose earlier import failed reuses the torrent already in qBittorrent', async () => {
  const qbt = fakeQbittorrent([{ hash, tags: 'tomify-old-job' }])
  const reusable = await findReusableTorrent({ infoHash: hash }, { client: qbt.client, loadJob: async () => failedJob, savedJobs: async () => [] })
  assert.deepEqual(reusable, { hash, tags: ['tomify-old-job'] })
  assert.equal(qbt.calls.find((call) => call.path === '/api/v2/torrents/info').query.hashes, hash)

  assert.deepEqual(await qbt.client.retag(hash, { tag: 'tomify-new-job', previousTags: reusable.tags }), { downloader: 'qbittorrent', remoteId: 'tomify-new-job' })
  assert.deepEqual(qbt.calls.find((call) => call.path === '/api/v2/torrents/addTags').body, { hashes: hash, tags: 'tomify-new-job' })
  assert.deepEqual(qbt.calls.find((call) => call.path === '/api/v2/torrents/removeTags').body, { hashes: hash, tags: 'tomify-old-job' })
})

test('a .torrent file link finds the info hash on the earlier failed job for the same link', async () => {
  const qbt = fakeQbittorrent([{ hash, tags: 'tomify-old-job' }])
  const reusable = await findReusableTorrent({ infoHash: null, resultId: 'link-result-id' }, { client: qbt.client, loadJob: async () => failedJob, savedJobs: async () => [{ ...failedJob, status: 'completed', result: { resultId: 'other' } }, failedJob] })
  assert.equal(reusable?.hash, hash)
  assert.equal(await findReusableTorrent({ infoHash: null, resultId: 'unknown' }, { client: qbt.client, loadJob: async () => failedJob, savedJobs: async () => [failedJob] }), null)
})

test('a torrent that a live job is using, or that Tomify did not add, is not taken over', async () => {
  const live = fakeQbittorrent([{ hash, tags: 'tomify-old-job' }])
  assert.equal(await findReusableTorrent({ infoHash: hash }, { client: live.client, loadJob: async () => ({ ...failedJob, status: 'downloading' }), savedJobs: async () => [] }), null)
  const manual = fakeQbittorrent([{ hash, tags: 'music' }])
  assert.equal(await findReusableTorrent({ infoHash: hash }, { client: manual.client, loadJob: async () => null, savedJobs: async () => [] }), null)
  const absent = fakeQbittorrent([])
  assert.equal(await findReusableTorrent({ infoHash: hash }, { client: absent.client, loadJob: async () => null, savedJobs: async () => [] }), null)
})
