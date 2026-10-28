// A short record of what started or stopped the music on this device: lock screen and headphone
// buttons, audio devices coming and going, and plays Tomify refused. Some playback bugs only happen
// on a phone with real headphones, so this lets the listener copy what happened from Settings.
export const PLAYBACK_LOG_KEY = 'tomify-playback-log'
export const PLAYBACK_LOG_LIMIT = 40

export type PlaybackLogEntry = { at: number; event: string; detail?: string }

function read(): PlaybackLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PLAYBACK_LOG_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is PlaybackLogEntry => typeof entry?.at === 'number' && typeof entry?.event === 'string') : []
  } catch {
    return []
  }
}

export function logPlayback(event: string, detail?: string, now = Date.now()) {
  const entries = [...read(), detail ? { at: now, event, detail } : { at: now, event }].slice(-PLAYBACK_LOG_LIMIT)
  try { localStorage.setItem(PLAYBACK_LOG_KEY, JSON.stringify(entries)) } catch { /* storage full or blocked */ }
}

export function playbackLog(): PlaybackLogEntry[] {
  return read()
}

export function clearPlaybackLog() {
  try { localStorage.removeItem(PLAYBACK_LOG_KEY) } catch { /* storage blocked */ }
}

export function formatPlaybackLog(entries: PlaybackLogEntry[]): string {
  return entries.map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false })
    return `${time}  ${entry.event}${entry.detail ? ` (${entry.detail})` : ''}`
  }).join('\n')
}
