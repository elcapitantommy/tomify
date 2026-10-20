// Desktop keyboard shortcuts. `shortcutFor` turns a key press into an action; the hook in
// components/KeyboardShortcuts.tsx carries it out on this device or the one playing elsewhere.
export type ShortcutAction =
  | 'toggle-play' | 'next' | 'previous' | 'seek-forward' | 'seek-back'
  | 'volume-up' | 'volume-down' | 'mute' | 'shuffle' | 'repeat'
  | 'like' | 'search' | 'now-playing' | 'queue' | 'help'

export interface ShortcutKey { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

export const SEEK_STEP_SECONDS = 10
export const VOLUME_STEP = 0.1

// Shown in the "?" help panel, in this order.
export const SHORTCUT_HELP: Array<{ keys: string[]; label: string }> = [
  { keys: ['Space'], label: 'Play or pause' },
  { keys: ['Shift', '→'], label: 'Next song' },
  { keys: ['Shift', '←'], label: 'Previous song' },
  { keys: ['→'], label: `Forward ${SEEK_STEP_SECONDS} seconds` },
  { keys: ['←'], label: `Back ${SEEK_STEP_SECONDS} seconds` },
  { keys: ['Shift', '↑'], label: 'Volume up' },
  { keys: ['Shift', '↓'], label: 'Volume down' },
  { keys: ['M'], label: 'Mute or unmute' },
  { keys: ['S'], label: 'Shuffle on or off' },
  { keys: ['R'], label: 'Change repeat' },
  { keys: ['L'], label: 'Like or unlike the song playing' },
  { keys: ['F'], label: 'Open or close Now Playing' },
  { keys: ['Q'], label: 'Open or close the queue' },
  { keys: ['/'], label: 'Search' },
  { keys: ['?'], label: 'Show these shortcuts' },
]

export function shortcutFor(event: ShortcutKey): ShortcutAction | null {
  // Browser and system shortcuts (Ctrl+F, Cmd+R…) are left alone.
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = event.key
  if (key === ' ' || key === 'Spacebar') return 'toggle-play'
  if (key === 'ArrowRight') return event.shiftKey ? 'next' : 'seek-forward'
  if (key === 'ArrowLeft') return event.shiftKey ? 'previous' : 'seek-back'
  // Plain up and down still scroll the page.
  if (key === 'ArrowUp') return event.shiftKey ? 'volume-up' : null
  if (key === 'ArrowDown') return event.shiftKey ? 'volume-down' : null
  if (key === '/') return 'search'
  if (key === '?') return 'help'
  switch (key.toLowerCase()) {
    case 'k': return 'toggle-play'
    case 'm': return 'mute'
    case 's': return 'shuffle'
    case 'r': return 'repeat'
    case 'l': return 'like'
    case 'f': return 'now-playing'
    case 'q': return 'queue'
    default: return null
  }
}

// Typing in a box (search, playlist names, the DJ) or moving a slider must not trigger shortcuts.
export function isTypingTarget(target: EventTarget | null) {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  if (element.isContentEditable) return true
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"], [role="slider"]'))
}

export function stepVolume(volume: number, direction: 1 | -1) {
  return Math.round(Math.min(1, Math.max(0, volume + direction * VOLUME_STEP)) * 100) / 100
}

export function seekTarget(currentTime: number, duration: number, direction: 1 | -1) {
  const target = currentTime + direction * SEEK_STEP_SECONDS
  return Math.max(0, duration > 0 ? Math.min(duration - 1, target) : target)
}
