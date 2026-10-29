// HLS playlists over YouTube's own fragmented MP4 files.
//
// Safari (and AVPlayer in a future native app) plays HLS natively, including fMP4 segments addressed
// as byte ranges of one file (EXT-X-MAP and EXT-X-BYTERANGE, HLS version 7). Every segment line
// names the same relative file, `<itag>.mp4` or `<itag>.m4a`, which the service streams with range
// requests; the phone fetches exactly the bytes of each fragment. Nothing is remuxed or transcoded.
//
// Playlists name files relatively and carry no credentials; the Worker adds the phone's media token
// to every URI when it passes a playlist on.

export const HLS_VERSION = 7

export function streamFileName(format) {
  return `${format.itag}.${format.kind === 'audio' ? 'm4a' : 'mp4'}`
}

function byteRange(range) {
  return `${range.end - range.start + 1}@${range.start}`
}

function extinf(seconds) {
  return `#EXTINF:${Math.max(0.001, seconds).toFixed(3)},`
}

function targetDuration(segments) {
  return Math.max(1, Math.ceil(Math.max(...segments.map((segment) => segment.duration))))
}

function segmentLines(index, uri) {
  const lines = [`#EXT-X-MAP:URI="${uri}",BYTERANGE="${byteRange(index.init)}"`]
  for (const segment of index.segments) lines.push(extinf(segment.duration), `#EXT-X-BYTERANGE:${byteRange(segment)}`, uri)
  return lines
}

// One video or audio stream as a VOD media playlist.
export function mediaPlaylist(index, uri) {
  return [
    '#EXTM3U',
    `#EXT-X-VERSION:${HLS_VERSION}`,
    `#EXT-X-TARGETDURATION:${targetDuration(index.segments)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...segmentLines(index, uri),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
}

function rank(variant, preferredHeight) {
  return Math.abs(variant.height - preferredHeight)
}

// Video variants with one shared audio rendition. Safari starts with the first variant listed, so the
// one nearest `startHeight` comes first; it then moves up or down with the connection. Without an
// audio format it is video only: the iPhone app plays sound from a separate <audio> element and the
// picture muted, so the audio isn't fetched twice.
export function masterPlaylist(videoFormats, audioFormat, { startHeight = 720 } = {}) {
  if (!videoFormats.length) throw new TypeError('A master playlist needs video.')
  const first = [...videoFormats].sort((a, b) => rank(a, startHeight) - rank(b, startHeight) || b.height - a.height)[0]
  const ordered = [first, ...videoFormats.filter((format) => format !== first)]
  const audioBitrate = audioFormat ? audioFormat.bitrate || 128_000 : 0
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${HLS_VERSION}`, '#EXT-X-INDEPENDENT-SEGMENTS']
  if (audioFormat) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="a${audioFormat.itag}.m3u8"`)
  for (const format of ordered) {
    const bandwidth = (format.bitrate || 1_000_000) + audioBitrate
    const attributes = [
      `BANDWIDTH=${Math.round(bandwidth * 1.2)}`,
      `AVERAGE-BANDWIDTH=${Math.round(bandwidth)}`,
      `CODECS="${audioFormat ? `${format.vcodec},${audioFormat.acodec}` : format.vcodec}"`,
    ]
    if (format.width && format.height) attributes.push(`RESOLUTION=${format.width}x${format.height}`)
    if (format.fps) attributes.push(`FRAME-RATE=${Number(format.fps).toFixed(3)}`)
    if (audioFormat) attributes.push('AUDIO="audio"')
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, `v${format.itag}.m3u8`)
  }
  lines.push('')
  return lines.join('\n')
}

// A fixed quality: only the largest variant no taller than `height` (or the smallest there is), so
// Safari can't step down to a lower one on a slow start. Adaptive playback is the default.
export function fixedHeight(videoFormats, height) {
  if (!height || videoFormats.length < 2) return videoFormats
  const fits = videoFormats.filter((format) => format.height && format.height <= height)
  const pick = fits.length
    ? fits.reduce((best, format) => (format.height > best.height || (format.height === best.height && (format.bitrate || 0) > (best.bitrate || 0)) ? format : best))
    : videoFormats.reduce((best, format) => ((format.height || Infinity) < (best.height || Infinity) ? format : best))
  return [pick]
}

// Several videos' audio as one continuous stream: each track is its own discontinuity with its own
// initialisation section. The phone plays straight from one track into the next without JavaScript
// having to start anything, which is the experimental way round iOS's limits on a locked screen.
// `tracks` is [{ videoId, format, index }]; URIs are relative to `/v1/queue.m3u8`.
export function queuePlaylist(tracks) {
  if (!tracks.length) throw new TypeError('A queue playlist needs at least one track.')
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${HLS_VERSION}`,
    `#EXT-X-TARGETDURATION:${Math.max(...tracks.map((track) => targetDuration(track.index.segments)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  tracks.forEach((track, position) => {
    if (position > 0) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(...segmentLines(track.index, `videos/${track.videoId}/${streamFileName(track.format)}`))
  })
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

// Where each track starts in the continuous stream, from the same segment durations the playlist uses.
export function queueTimeline(tracks) {
  let offset = 0
  return tracks.map((track) => {
    const duration = track.index.segments.reduce((sum, segment) => sum + segment.duration, 0)
    const entry = { id: track.videoId, offset, duration }
    offset += duration
    return entry
  })
}
