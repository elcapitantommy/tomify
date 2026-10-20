// Playing to a speaker or TV from the browser: AirPlay in Safari (iPhone, iPad, Mac) and Chromecast through
// the Remote Playback API in Chrome (Android, desktop). Both play one <audio> element on the speaker, so
// while casting the player keeps every song on that element and streams original files (an hls.js stream
// is built in the browser and can't be sent).
export type CastKind = 'airplay' | 'cast'
export type CastState = 'disconnected' | 'connecting' | 'connected'

// Safari's AirPlay additions; `remote` (Remote Playback API) is missing in browsers without it.
export interface CastableElement extends Omit<HTMLMediaElement, 'remote'> {
  webkitShowPlaybackTargetPicker?: () => void
  webkitCurrentPlaybackTargetIsWireless?: boolean
  remote?: RemotePlayback
}

export function castKind(element: CastableElement | null | undefined): CastKind | null {
  if (!element) return null
  if (typeof element.webkitShowPlaybackTargetPicker === 'function') return 'airplay'
  if (element.remote && typeof element.remote.prompt === 'function') return 'cast'
  return null
}

export function castElementState(element: CastableElement, kind: CastKind): CastState {
  if (kind === 'airplay') return element.webkitCurrentPlaybackTargetIsWireless ? 'connected' : 'disconnected'
  return element.remote?.state ?? 'disconnected'
}

// The browser's reasons for not casting, in words.
export function castErrorMessage(error: unknown) {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  if (name === 'NotFoundError') return 'No speakers or TVs were found on this network.'
  if (name === 'NotSupportedError') return 'This song can’t be cast from this browser.'
  if (name === 'AbortError' || name === 'NotAllowedError') return null
  return 'Casting didn’t start. Try again.'
}

export const castLabels: Record<CastKind, { action: string; detail: string }> = {
  airplay: { action: 'AirPlay', detail: 'Play on an AirPlay speaker or Apple TV' },
  cast: { action: 'Cast', detail: 'Play on a Chromecast, Nest speaker or smart TV' },
}
