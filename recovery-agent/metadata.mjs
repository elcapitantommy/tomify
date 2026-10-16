import { classifyQuality } from '../shared/quality.mjs'

// ffprobe replaces tag bytes that are not valid UTF-8 with U+FFFD by default, which loses
// Latin-1 tags such as "M\xF6tley Cr\xFCe" for good. sv=ignore passes the raw bytes through
// so the agent can decode them itself (text-encoding.mjs decodeToolOutput).
export const ffprobeTagJsonFormat = 'json=string_validation=ignore'

// TOMIFY_ARCHIVE_STATUS records the quality tier of the source (lossless, transparent-lossy, lossy or
// unknown), measured by ffprobe before tagging. It is still a recovery copy, never a verified master.
export function ffmpegMetadataArguments(track, comment, sourceQuality = null) {
  const values = [
    ['artist', track?.artist],
    ['album_artist', track?.albumArtist],
    ['title', track?.title],
    ['album', track?.album],
    ['date', track?.releaseDate],
    ['track', track?.trackNumber],
    ['disc', track?.discNumber],
    ['MUSICBRAINZ_TRACKID', track?.recordingId],
    ['MUSICBRAINZ_ALBUMID', track?.releaseId],
    ['MUSICBRAINZ_RELEASEGROUPID', track?.releaseGroupId],
    ['ISRC', track?.isrc],
    ['comment', comment],
    ['TOMIFY_ARCHIVE_STATUS', classifyQuality(sourceQuality).tier],
    ['TOMIFY_SOURCE_URL', track?.sourceUrl],
  ]
  return values.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '').flatMap(([key, value]) => ['-metadata', `${key}=${value}`])
}
