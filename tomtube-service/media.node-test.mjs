import test from 'node:test'
import assert from 'node:assert/strict'
import { selectFormats, publicFormat, videoSummary, urlExpiry, earliestExpiry, findFormat, searchResult } from './formats.mjs'
import { groupSegments, Mp4IndexError, readIndex, topLevelBoxes } from './mp4.mjs'
import { fixedHeight, masterPlaylist, mediaPlaylist, queuePlaylist, queueTimeline } from './hls.mjs'
import { box, fragmentedMp4, ytdlpInfo } from './testing.mjs'

test('only H.264 video, AAC audio and the progressive MP4 over plain HTTPS are chosen', () => {
  const selection = selectFormats(ytdlpInfo('dQw4w9WgXcQ').formats)
  assert.deepEqual(selection.video.map((format) => format.itag), ['134', '136', '137'])
  assert.deepEqual(selection.audio.map((format) => format.itag), ['140', '139'])
  assert.equal(selection.audio[0].formatId, '140', 'the stable-volume copy is not preferred')
  assert.deepEqual(selection.progressive.map((format) => format.itag), ['18'])
  assert.equal(selection.audio[0].mimeType, 'audio/mp4')
  assert.equal(selection.video[0].mimeType, 'video/mp4')
  assert.equal(selection.audio[0].chunkSize, 10485760)
})

test('the height limit drops larger video variants', () => {
  const selection = selectFormats(ytdlpInfo('dQw4w9WgXcQ').formats, { maxHeight: 720 })
  assert.deepEqual(selection.video.map((format) => format.itag), ['134', '136'])
})

test('a dubbed audio track is only used when the original is missing', () => {
  const formats = [
    { format_id: '140-0', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, language: 'de', language_preference: -1, protocol: 'https', url: 'https://a.googlevideo.com/1' },
    { format_id: '140-1', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, language: 'en', language_preference: 10, protocol: 'https', url: 'https://a.googlevideo.com/2' },
  ]
  assert.equal(selectFormats(formats).audio[0].language, 'en')
})

test('what the phone sees never contains upstream URLs or request headers', () => {
  const info = ytdlpInfo('dQw4w9WgXcQ')
  const selection = selectFormats(info.formats)
  const summary = videoSummary(info, selection)
  const text = JSON.stringify(summary)
  assert.doesNotMatch(text, /googlevideo|sig=|expire=|User-Agent|never-forward/i)
  assert.equal(summary.title, 'Video dQw4w9WgXcQ')
  assert.equal(summary.channel, 'Test Channel')
  assert.equal(summary.duration, 30)
  assert.deepEqual(summary.playback, { hls: true, progressive: true, audio: true })
  assert.equal(publicFormat(selection.audio[0]).url, undefined)
})

test('expiry comes from the googlevideo URL', () => {
  assert.equal(urlExpiry('https://x.googlevideo.com/v?expire=1700000000&x=1'), 1700000000000)
  assert.equal(urlExpiry('not a url'), null)
  const selection = selectFormats(ytdlpInfo('dQw4w9WgXcQ', { expire: '1700000000' }).formats)
  assert.equal(earliestExpiry(selection), 1700000000000)
  assert.equal(findFormat(selection, '136').height, 720)
  assert.equal(findFormat(selection, '999'), null)
})

test('search results keep only YouTube videos with the fields the list shows', () => {
  assert.deepEqual(searchResult({ id: 'dQw4w9WgXcQ', ie_key: 'Youtube', title: 'T', channel: 'C', duration: 212, view_count: 5, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), { id: 'dQw4w9WgXcQ', title: 'T', channel: 'C', channelId: null, duration: 212, viewCount: 5, isLive: false })
  assert.equal(searchResult({ id: 'UCxxxxxxxxxxxxxxxxxxxxxx', ie_key: 'YoutubeTab' }), null)
  assert.equal(searchResult({ id: 'short' }), null)
})

test('the segment index of a fragmented MP4 gives every fragment its bytes and duration', () => {
  for (const version of [0, 1]) {
    const file = fragmentedMp4({ count: 6, seconds: 5, version })
    const index = readIndex(file, file.length)
    assert.equal(index.segments.length, 6)
    assert.equal(index.duration, 30)
    const boxes = topLevelBoxes(file)
    const moov = boxes.find((entry) => entry.type === 'moov')
    assert.deepEqual(index.init, { start: 0, end: moov.start + moov.size - 1 })
    const firstFragment = boxes.find((entry) => entry.type === 'moof')
    assert.equal(index.segments[0].start, firstFragment.start)
    assert.equal(index.segments.at(-1).end, file.length - 1)
    for (const segment of index.segments) assert.equal(file.toString('latin1', segment.start + 4, segment.start + 8), 'moof')
  }
})

test('a partial download asks for more bytes before the index is complete', () => {
  const file = fragmentedMp4({ count: 400, seconds: 5 })
  const first = readIndex(file.subarray(0, 700), file.length)
  assert.ok(first.needed > 700)
  const partial = readIndex(file.subarray(0, 2000), file.length)
  assert.ok(partial.needed > 2000, 'the sidx is cut off at 2000 bytes')
  assert.equal(readIndex(file.subarray(0, partial.needed), file.length).segments.length, 400)
})

test('files without a usable index are reported, not guessed at', () => {
  const noIndex = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(20)), box('moof', Buffer.alloc(8)), box('mdat', Buffer.alloc(100))])
  assert.throws(() => readIndex(noIndex, noIndex.length), Mp4IndexError)
  const noMoov = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(100))])
  assert.throws(() => readIndex(noMoov, noMoov.length), Mp4IndexError)
  assert.throws(() => topLevelBoxes(Buffer.from([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70])), Mp4IndexError)
})

test('short fragments are joined into segments of at least four seconds', () => {
  const segments = [0, 1, 2, 3, 4].map((index) => ({ start: index * 100, end: index * 100 + 99, duration: 2 }))
  assert.deepEqual(groupSegments(segments, 4), [
    { start: 0, end: 199, duration: 4 },
    { start: 200, end: 399, duration: 4 },
    { start: 400, end: 499, duration: 2 },
  ])
})

test('media playlists address each fragment as a byte range of one file', () => {
  const file = fragmentedMp4({ count: 3, seconds: 5 })
  const index = readIndex(file, file.length)
  const playlist = mediaPlaylist(index, '140.m4a')
  const lines = playlist.trim().split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.ok(lines.includes('#EXT-X-VERSION:7'))
  assert.ok(lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:5'))
  assert.equal(lines.at(-1), '#EXT-X-ENDLIST')
  assert.ok(lines.includes(`#EXT-X-MAP:URI="140.m4a",BYTERANGE="${index.init.end + 1}@0"`))
  const ranges = lines.filter((line) => line.startsWith('#EXT-X-BYTERANGE:')).map((line) => line.slice(17))
  assert.deepEqual(ranges, index.segments.map((segment) => `${segment.end - segment.start + 1}@${segment.start}`))
  assert.equal(lines.filter((line) => line === '140.m4a').length, 3)
  assert.equal(lines.filter((line) => line.startsWith('#EXTINF:5.000,')).length, 3)
})

test('the master playlist starts near 720p and shares one AAC rendition', () => {
  const selection = selectFormats(ytdlpInfo('dQw4w9WgXcQ').formats)
  const lines = masterPlaylist(selection.video, selection.audio[0]).trim().split('\n')
  assert.match(lines[3], /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio".*URI="a140\.m3u8"$/)
  const variants = lines.filter((line) => /^v\d+\.m3u8$/.test(line))
  assert.deepEqual(variants, ['v136.m3u8', 'v134.m3u8', 'v137.m3u8'])
  assert.match(lines[4], /CODECS="avc1\.4D401F,mp4a\.40\.2",RESOLUTION=1280x720,FRAME-RATE=25\.000,AUDIO="audio"/)
})

test('the video-only master playlist has the same variants and no audio', () => {
  const selection = selectFormats(ytdlpInfo('dQw4w9WgXcQ').formats)
  const playlist = masterPlaylist(selection.video, null)
  assert.equal(playlist.includes('TYPE=AUDIO'), false)
  assert.equal(playlist.includes('mp4a'), false)
  assert.equal(playlist.includes('AUDIO='), false)
  assert.deepEqual(playlist.split('\n').filter((line) => /^v\d+\.m3u8$/.test(line)), ['v136.m3u8', 'v134.m3u8', 'v137.m3u8'])
  assert.match(playlist, /CODECS="avc1\.4D401F",RESOLUTION=1280x720/)
})

test('a fixed height keeps only the largest variant up to it, or the smallest if none fits', () => {
  const { video } = selectFormats(ytdlpInfo('dQw4w9WgXcQ').formats)
  assert.deepEqual(fixedHeight(video, 1080).map((format) => format.itag), ['137'])
  assert.deepEqual(fixedHeight(video, 720).map((format) => format.itag), ['136'])
  assert.deepEqual(fixedHeight(video, 240).map((format) => format.itag), ['134'])
  assert.equal(fixedHeight(video, null), video)
})

test('the queue playlist plays several tracks back to back with discontinuities', () => {
  const file = fragmentedMp4({ count: 2, seconds: 5 })
  const index = readIndex(file, file.length)
  const format = { itag: '140', kind: 'audio' }
  const tracks = [{ videoId: 'aaaaaaaaaaa', format, index }, { videoId: 'bbbbbbbbbbb', format, index }]
  const playlist = queuePlaylist(tracks)
  assert.equal((playlist.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1)
  assert.equal((playlist.match(/#EXT-X-MAP:URI="videos\/aaaaaaaaaaa\/140\.m4a"/g) || []).length, 1)
  assert.equal((playlist.match(/^videos\/bbbbbbbbbbb\/140\.m4a$/gm) || []).length, 2)
  assert.deepEqual(queueTimeline(tracks), [{ id: 'aaaaaaaaaaa', offset: 0, duration: 10 }, { id: 'bbbbbbbbbbb', offset: 10, duration: 10 }])
})
