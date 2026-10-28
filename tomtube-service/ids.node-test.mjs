import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSearchQuery, parseYouTubeVideoId, thumbnailUrl, watchUrl } from './ids.mjs'

test('YouTube links of every common shape give the video id', () => {
  const id = 'dQw4w9WgXcQ'
  for (const link of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&feature=share`,
    `https://youtu.be/${id}?si=abc`,
    `youtu.be/${id}`,
    `www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `  https://www.youtube.com/watch?v=${id}  `,
  ]) assert.equal(parseYouTubeVideoId(link), id, link)
})

test('anything that is not a YouTube video link is refused', () => {
  for (const link of [
    '',
    null,
    'hello world',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/?u=https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ0',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@channel',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'https://rr1---sn-abc.googlevideo.com/videoplayback?id=1',
    'x'.repeat(5000),
  ]) assert.equal(parseYouTubeVideoId(link), null, String(link).slice(0, 80))
})

test('watch and thumbnail URLs are built only from valid ids and fixed names', () => {
  assert.equal(watchUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.throws(() => watchUrl('../../etc'), TypeError)
  assert.equal(thumbnailUrl('dQw4w9WgXcQ', 'hqdefault'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(thumbnailUrl('dQw4w9WgXcQ', '../x'), null)
  assert.equal(thumbnailUrl('bad', 'hqdefault'), null)
})

test('search text is one line, trimmed and bounded', () => {
  assert.equal(cleanSearchQuery('  lofi\n\t hip   hop\u0000 '), 'lofi hip hop')
  assert.equal(cleanSearchQuery('a'.repeat(500)).length, 200)
  assert.equal(cleanSearchQuery(undefined), '')
})
