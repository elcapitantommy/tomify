export function sanitizeToolError(value, sensitiveValues = []) {
  let text = String(value || '')
  for (const sensitive of sensitiveValues.filter(Boolean)) text = text.split(String(sensitive)).join('[redacted]')
  return text
    .replace(/--cookies(?:=|\s+)\S+/gi, '--cookies [redacted]')
    .replace(/\/opt\/tomify\/secrets\/[^\s:'"]+/gi, '[redacted-secret-file]')
    .replace(/(?:^|\s)(?:Cookie|Authorization):[^\r\n]*/gi, ' [redacted-credential]')
    .slice(-600)
}

export function audioFormatSummary(format) {
  return {
    formatId: String(format?.format_id || ''),
    codec: format?.acodec && format.acodec !== 'none' ? String(format.acodec) : null,
    container: format?.ext ? String(format.ext) : null,
    bitrate: Number(format?.abr || format?.tbr) || null,
    sampleRate: Number(format?.asr) || null,
    channels: Number(format?.audio_channels) || null,
    audioOnly: format?.vcodec === 'none',
  }
}

function qualityScore(format) {
  const audioOnly = format?.vcodec === 'none' ? 1_000_000_000 : 0
  const preference = Number(format?.preference || 0) * 10_000_000
  const quality = Number(format?.quality || 0) * 1_000_000
  const bitrate = Number(format?.abr || format?.tbr || 0) * 10_000
  const sampleRate = Number(format?.asr || 0) * 10
  const channels = Number(format?.audio_channels || 0)
  return audioOnly + preference + quality + bitrate + sampleRate + channels
}

export function selectBestAudioFormat(formats) {
  const audio = (Array.isArray(formats) ? formats : []).filter((format) => format?.format_id && format?.acodec && format.acodec !== 'none')
  if (!audio.length) return null
  const audioOnly = audio.filter((format) => format.vcodec === 'none')
  return [...(audioOnly.length ? audioOnly : audio)].sort((a, b) => qualityScore(b) - qualityScore(a))[0]
}
