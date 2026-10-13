export function ffmpegMetadataArguments(track, comment) {
  const values = [
    ['artist', track?.artist],
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
    ['TOMIFY_ARCHIVE_STATUS', 'lossy-recovery-copy'],
    ['TOMIFY_SOURCE_URL', track?.sourceUrl],
  ]
  return values.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '').flatMap(([key, value]) => ['-metadata', `${key}=${value}`])
}
