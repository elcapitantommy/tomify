import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const instances: FakeHls[] = []
class FakeHls {
  static Events = { ERROR: 'error', FRAG_LOADED: 'fragLoaded' }
  static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
  static isSupported = () => true
  handlers: Record<string, (event: string, data: unknown) => void> = {}
  source?: string
  media?: HTMLMediaElement
  destroyed = false
  started: number[] = []
  bandwidthEstimate = 0
  recoveries = 0
  constructor(readonly config: { autoStartLoad: boolean; abrEwmaDefaultEstimate: number }) { instances.push(this) }
  on(event: string, handler: (event: string, data: unknown) => void) { this.handlers[event] = handler }
  loadSource(url: string) { this.source = url }
  attachMedia(media: HTMLMediaElement) { this.media = media }
  startLoad(position: number) { this.started.push(position) }
  recoverMediaError() { this.recoveries += 1 }
  destroy() { this.destroyed = true }
  emit(event: string, data: unknown) { this.handlers[event]?.(event, data) }
}
vi.mock('hls.js/light', () => ({ default: FakeHls }))

const adaptive = await import('./adaptiveStream')
const { AdaptiveSources, chooseSource, isUnavailableError, loadHlsLibrary, markAdaptiveUnavailable, resetAdaptiveAvailability, wantsAdaptive } = adaptive
const urls = { direct: 'https://app.test/navidrome/rest/stream.view?id=a', hls: 'https://app.test/api/hls/a/master.m3u8?u=tom' }

describe('adaptive streaming', () => {
  beforeEach(() => {
    instances.length = 0
    resetAdaptiveAvailability()
    vi.stubGlobal('MediaSource', class {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('follows the quality setting and the connection type', () => {
    expect(wantsAdaptive('adaptive', { type: 'wifi' })).toBe(true)
    expect(wantsAdaptive('original', { type: 'cellular' })).toBe(false)
    expect(wantsAdaptive('original-on-wifi', { type: 'wifi' })).toBe(false)
    expect(wantsAdaptive('original-on-wifi', { type: 'cellular' })).toBe(true)
    // Browsers that don't say what the connection is are treated as mobile data.
    expect(wantsAdaptive('original-on-wifi', undefined)).toBe(true)
  })

  it('streams the original file until hls.js has loaded, and for servers without adaptive streaming', async () => {
    const element = document.createElement('audio')
    expect(chooseSource(element, { ...urls, hls: null }, 'adaptive')).toEqual({ kind: 'direct', url: urls.direct })
    expect(chooseSource(element, urls, 'original')).toEqual({ kind: 'direct', url: urls.direct })
    await loadHlsLibrary()
    expect(chooseSource(element, urls, 'adaptive')).toEqual({ kind: 'hls', url: urls.hls })
    markAdaptiveUnavailable()
    expect(chooseSource(element, urls, 'adaptive')).toEqual({ kind: 'direct', url: urls.direct })
    expect(chooseSource(element, urls, 'adaptive', Date.now() + 11 * 60_000)).toEqual({ kind: 'hls', url: urls.hls })
  })

  it('uses Safari’s own HLS player where there is no MediaSource (iPhone)', () => {
    vi.stubGlobal('MediaSource', undefined)
    const element = document.createElement('audio')
    vi.spyOn(element, 'canPlayType').mockReturnValue('maybe')
    expect(chooseSource(element, urls, 'adaptive')).toEqual({ kind: 'hls', url: urls.hls })
    const sources = new AdaptiveSources()
    sources.attach(element, { kind: 'hls', url: urls.hls }, { preload: 'auto', onFatal: () => {} })
    expect(element.src).toBe(urls.hls)
    expect(instances).toHaveLength(0)
  })

  it('attaches hls.js, waits to download chunks for a paused track, and cleans up on the next load', async () => {
    await loadHlsLibrary()
    const element = document.createElement('audio')
    const sources = new AdaptiveSources()
    const onFatal = vi.fn()
    sources.attach(element, { kind: 'hls', url: urls.hls }, { preload: 'metadata', onFatal })
    const [hls] = instances
    expect(hls.source).toBe(urls.hls)
    expect(hls.media).toBe(element)
    expect(hls.config.autoStartLoad).toBe(false)
    expect(sources.matches(element, { kind: 'hls', url: urls.hls })).toBe(true)
    sources.startLoading(element)
    sources.startLoading(element)
    expect(hls.started).toEqual([-1])

    hls.emit('error', { fatal: true, type: 'mediaError', details: 'bufferStalledError' })
    expect(hls.recoveries).toBe(1)
    expect(onFatal).not.toHaveBeenCalled()
    hls.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 503 } })
    expect(onFatal).toHaveBeenCalledWith(true)

    sources.attach(element, { kind: 'direct', url: urls.direct }, { preload: 'auto', onFatal })
    expect(hls.destroyed).toBe(true)
    expect(element.src).toBe(urls.direct)
    expect(sources.matches(element, { kind: 'hls', url: urls.hls })).toBe(false)
  })

  it('starts the next track at the bandwidth the last one measured', async () => {
    await loadHlsLibrary()
    const sources = new AdaptiveSources()
    sources.attach(document.createElement('audio'), { kind: 'hls', url: urls.hls }, { preload: 'auto', onFatal: () => {} })
    instances[0].bandwidthEstimate = 900_000
    instances[0].emit('fragLoaded', {})
    sources.attach(document.createElement('audio'), { kind: 'hls', url: urls.hls }, { preload: 'auto', onFatal: () => {} })
    expect(instances[1].config.abrEwmaDefaultEstimate).toBe(900_000)
  })

  it('treats a server error on a playlist as "not available" and a lost connection as a signal drop', () => {
    expect(isUnavailableError({ fatal: true, details: 'manifestLoadError', response: { code: 503, text: '' } } as never)).toBe(true)
    expect(isUnavailableError({ fatal: true, details: 'levelLoadError', response: { code: 404, text: '' } } as never)).toBe(true)
    expect(isUnavailableError({ fatal: true, details: 'manifestLoadError', response: { code: 0, text: '' } } as never)).toBe(false)
    expect(isUnavailableError({ fatal: true, details: 'fragLoadError', response: { code: 404, text: '' } } as never)).toBe(false)
  })
})
