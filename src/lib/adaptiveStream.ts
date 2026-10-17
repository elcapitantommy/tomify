// Adaptive streaming (HLS). The recovery agent on the box cuts each track into 6-second
// chunks at 64, 128 and 256 kbps; hls.js picks the bitrate chunk by chunk from how fast
// they arrive. Safari plays HLS itself. Anything that can't, or a box without the
// feature, gets the original file exactly as before.
import type Hls from 'hls.js/light'
import type { ErrorData, HlsConfig } from 'hls.js/light'
import type { StreamQuality } from '../stores/streamQuality'

export type StreamSource = { kind: 'hls' | 'direct'; url: string }

type HlsModule = typeof import('hls.js/light')
let hlsModule: HlsModule | null = null
let hlsLoading: Promise<HlsModule | null> | null = null

export function loadHlsLibrary(): Promise<HlsModule | null> {
  hlsLoading ??= import('hls.js/light').then((module) => (hlsModule = module), () => { hlsLoading = null; return null })
  return hlsLoading
}

// When the box says adaptive streaming isn't there (old agent, turned off, track it can't read),
// the player streams originals for a while instead of asking again for every track.
const UNAVAILABLE_FOR_MS = 10 * 60_000
let unavailableUntil = 0
export function markAdaptiveUnavailable(now = Date.now()) { unavailableUntil = now + UNAVAILABLE_FOR_MS }
export function resetAdaptiveAvailability() { unavailableUntil = 0 }

interface NetworkInformationLike { type?: string; effectiveType?: string; downlink?: number; saveData?: boolean }
export function currentConnection(): NetworkInformationLike | undefined {
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection
}

export function wantsAdaptive(quality: StreamQuality, connection: NetworkInformationLike | undefined = currentConnection()) {
  if (quality === 'original') return false
  if (quality === 'original-on-wifi') return !['wifi', 'ethernet'].includes(connection?.type ?? '')
  return true
}

export type PlaybackEngine = 'hls.js' | 'native' | 'none'
export function playbackEngine(element: HTMLMediaElement): PlaybackEngine {
  // Phones with only ManagedMediaSource (iPhone) play HLS natively, which keeps background audio reliable.
  if (typeof window.MediaSource !== 'undefined' && (hlsModule === null || hlsModule.default.isSupported())) return 'hls.js'
  if (element.canPlayType('application/vnd.apple.mpegurl')) return 'native'
  return 'none'
}

export function chooseSource(element: HTMLMediaElement, urls: { direct: string; hls: string | null }, quality: StreamQuality, now = Date.now()): StreamSource {
  if (!urls.hls || now < unavailableUntil || !wantsAdaptive(quality)) return { kind: 'direct', url: urls.direct }
  const engine = playbackEngine(element)
  if (engine === 'native') return { kind: 'hls', url: urls.hls }
  if (engine === 'hls.js' && hlsModule) return { kind: 'hls', url: urls.hls }
  // hls.js loads in the background; this track streams the original while it does.
  if (engine === 'hls.js') void loadHlsLibrary()
  return { kind: 'direct', url: urls.direct }
}

// hls.js forgets its bandwidth estimate with each new track; carry it over so the next
// track starts at the bitrate the last one had settled on.
let bandwidthEstimate = 0
function startingEstimate() {
  if (bandwidthEstimate > 0) return bandwidthEstimate
  const downlink = currentConnection()?.downlink
  return downlink && downlink > 0 ? Math.min(5_000_000, Math.max(64_000, downlink * 1_000_000 * 0.7)) : 300_000
}

// Only a chunk that failed to download for lack of signal is worth retrying as HLS. Anything
// else (a playlist the box refused or never sent, a decoder that can't take the audio) means
// adaptive streaming isn't working here, so the player switches to the original file.
export function isUnavailableError(data: Pick<ErrorData, 'fatal' | 'type' | 'details' | 'response'>) {
  if (!data.fatal) return false
  const status = data.response?.code ?? 0
  const chunkSignalDrop = String(data.type) === 'networkError' && /^frag/i.test(String(data.details)) && status < 400
  return !chunkSignalDrop
}

type Attached = { source: StreamSource; hls?: Hls }

export interface AttachOptions { preload: 'auto' | 'metadata'; onFatal(unavailable: boolean): void }

export class AdaptiveSources {
  private readonly attached = new WeakMap<HTMLMediaElement, Attached>()

  matches(element: HTMLMediaElement, source: StreamSource) {
    const current = this.attached.get(element)?.source
    return current?.kind === source.kind && current.url === source.url
  }

  kind(element: HTMLMediaElement) { return this.attached.get(element)?.source.kind }

  attach(element: HTMLMediaElement, source: StreamSource, options: AttachOptions) {
    this.detach(element)
    element.preload = options.preload
    if (source.kind === 'direct' || playbackEngine(element) !== 'hls.js' || !hlsModule) {
      element.src = source.url
      element.load()
      this.attached.set(element, { source })
      return
    }
    const HlsClass = hlsModule.default
    const config: Partial<HlsConfig> = {
      autoStartLoad: options.preload === 'auto',
      enableWorker: false,
      // Audio chunks are small, so keep a minute buffered to ride out tunnels and dead spots.
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      abrEwmaDefaultEstimate: startingEstimate(),
    }
    const hls = new HlsClass(config)
    hls.on(HlsClass.Events.FRAG_LOADED, () => { if (hls.bandwidthEstimate > 0) bandwidthEstimate = hls.bandwidthEstimate })
    let mediaRecoveries = 0
    hls.on(HlsClass.Events.ERROR, (_event, data) => {
      if (!data.fatal || this.attached.get(element)?.hls !== hls) return
      if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
        mediaRecoveries += 1
        hls.recoverMediaError()
        return
      }
      console.warn('Tomify adaptive stream failed', data.type, data.details, data.response?.code ?? '')
      options.onFatal(isUnavailableError(data))
    })
    hls.loadSource(source.url)
    hls.attachMedia(element)
    this.attached.set(element, { source, hls })
  }

  // A paused, restored track only fetches its playlist; the chunks start when it plays.
  startLoading(element: HTMLMediaElement) {
    const hls = this.attached.get(element)?.hls
    if (hls && !hls.config.autoStartLoad) {
      hls.config.autoStartLoad = true
      hls.startLoad(-1)
    }
  }

  detach(element: HTMLMediaElement) {
    const current = this.attached.get(element)
    if (!current) return
    this.attached.delete(element)
    current.hls?.destroy()
  }
}
