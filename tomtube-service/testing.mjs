// Test helpers: small fragmented MP4 files with a segment index, and a fake googlevideo server.
// Used only by the *.node-test.mjs files.

export function box(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

function sidx(fragments, { version = 0, timescale = 1000, firstOffset = 0 } = {}) {
  const head = Buffer.alloc(version === 0 ? 20 : 28)
  head.writeUInt8(version, 0)
  head.writeUInt32BE(1, 4)
  head.writeUInt32BE(timescale, 8)
  if (version === 0) { head.writeUInt32BE(0, 12); head.writeUInt32BE(firstOffset, 16) } else { head.writeBigUInt64BE(0n, 12); head.writeBigUInt64BE(BigInt(firstOffset), 20) }
  const counts = Buffer.alloc(4)
  counts.writeUInt16BE(fragments.length, 2)
  const references = Buffer.concat(fragments.map((fragment) => {
    const reference = Buffer.alloc(12)
    reference.writeUInt32BE(fragment.length & 0x7fffffff, 0)
    reference.writeUInt32BE(Math.round(fragment.seconds * timescale), 4)
    reference.writeUInt32BE(0x90000000, 8)
    return reference
  }))
  return box('sidx', Buffer.concat([head, counts, references]))
}

// A fragmented MP4 like YouTube's: ftyp, moov, sidx, then `count` fragments of `seconds` each.
export function fragmentedMp4({ count = 6, seconds = 5, fragmentBytes = 1000, moovBytes = 600, version = 0 } = {}) {
  const ftyp = box('ftyp', Buffer.from('dash\0\0\0\0iso6mp41', 'latin1'))
  const moov = box('moov', Buffer.alloc(moovBytes, 0x6d))
  const fragments = []
  for (let index = 0; index < count; index += 1) {
    const moof = box('moof', Buffer.alloc(32, index))
    const mdat = box('mdat', Buffer.alloc(fragmentBytes - moof.length - 8, (index * 7 + 1) & 0xff))
    const bytes = Buffer.concat([moof, mdat])
    fragments.push({ bytes, length: bytes.length, seconds })
  }
  return Buffer.concat([ftyp, moov, sidx(fragments, { version }), ...fragments.map((fragment) => fragment.bytes)])
}

// A fetch() that serves `files` (url path → Buffer) for https://*.googlevideo.com and i.ytimg.com,
// honouring Range. `expired` is a set of URL `expire` values that answer 403. Records every request.
export function fakeYouTube(files, { expired = new Set(), images = {} } = {}) {
  const requests = []
  async function fetch(input, init = {}) {
    const url = new URL(String(input))
    const range = init.headers?.range || null
    requests.push({ url: url.href, range, headers: { ...init.headers } })
    if (url.hostname === 'i.ytimg.com') {
      const image = images[url.pathname]
      return image ? new Response(image, { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('missing', { status: 404 })
    }
    if (expired.has(url.searchParams.get('expire'))) return new Response('expired', { status: 403 })
    const body = files[url.pathname]
    if (!body) return new Response('missing', { status: 404 })
    const match = /^bytes=(\d+)-(\d+)?$/.exec(range || '')
    if (!match) return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    const start = Number(match[1])
    const end = Math.min(match[2] ? Number(match[2]) : body.length - 1, body.length - 1)
    return new Response(body.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1) } })
  }
  return { fetch, requests }
}

// yt-dlp's -J output for one video, with formats pointing at the fake server.
export function ytdlpInfo(videoId, { expire = '4102444800', files = {}, extraFormats = [] } = {}) {
  const url = (name) => `https://rr1---sn-test.googlevideo.com/${videoId}/${name}?expire=${expire}&itag=${name}&sig=secret`
  const size = (name) => files[`/${videoId}/${name}`]?.length ?? null
  return {
    id: videoId,
    title: `Video ${videoId}`,
    channel: 'Test Channel',
    channel_id: 'UCtest',
    duration: 30,
    view_count: 1234,
    live_status: 'not_live',
    thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }],
    formats: [
      { format_id: '139', ext: 'm4a', acodec: 'mp4a.40.5', vcodec: 'none', abr: 48, protocol: 'https', url: url('139'), filesize: size('139'), http_headers: { 'User-Agent': 'test-agent', Cookie: 'never-forward' } },
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129.5, protocol: 'https', url: url('140'), filesize: size('140'), http_headers: { 'User-Agent': 'test-agent' }, downloader_options: { http_chunk_size: 10485760 } },
      { format_id: '140-drc', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129.5, protocol: 'https', url: url('140'), filesize: size('140') },
      { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 140, protocol: 'https', url: url('251') },
      { format_id: '18', ext: 'mp4', acodec: 'mp4a.40.2', vcodec: 'avc1.42001E', width: 640, height: 360, fps: 25, tbr: 500, protocol: 'https', url: url('18'), filesize: size('18') },
      { format_id: '134', ext: 'mp4', acodec: 'none', vcodec: 'avc1.4D401E', width: 640, height: 360, fps: 25, tbr: 400, protocol: 'https', url: url('134'), filesize: size('134') },
      { format_id: '136', ext: 'mp4', acodec: 'none', vcodec: 'avc1.4D401F', width: 1280, height: 720, fps: 25, tbr: 1500, protocol: 'https', url: url('136'), filesize: size('136') },
      { format_id: '137', ext: 'mp4', acodec: 'none', vcodec: 'avc1.640028', width: 1920, height: 1080, fps: 25, tbr: 3000, protocol: 'https', url: url('137'), filesize: size('137') },
      { format_id: '248', ext: 'webm', acodec: 'none', vcodec: 'vp9', width: 1920, height: 1080, fps: 25, tbr: 2500, protocol: 'https', url: url('248') },
      { format_id: '401', ext: 'mp4', acodec: 'none', vcodec: 'av01.0.12M.08', width: 3840, height: 2160, fps: 25, tbr: 9000, protocol: 'https', url: url('401') },
      { format_id: '96', ext: 'mp4', acodec: 'mp4a.40.2', vcodec: 'avc1.640028', width: 1920, height: 1080, protocol: 'm3u8_native', url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x' },
      { format_id: 'sb0', ext: 'mhtml', acodec: 'none', vcodec: 'none', protocol: 'mhtml', url: 'https://i.ytimg.com/sb/x' },
      ...extraFormats,
    ],
  }
}
