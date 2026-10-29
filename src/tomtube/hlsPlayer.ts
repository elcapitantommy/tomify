// HLS for browsers that can't play it natively (Firefox, Chrome on desktop, Android). Safari and the
// iPhone play TomTube's playlists themselves; everywhere else hls.js feeds the <video> element through
// Media Source Extensions. Without this those browsers only got the 360p single-file MP4.
//
// The full build is used, not the light one Tomify's music player uses: TomTube's master playlist
// has a separate audio rendition (EXT-X-MEDIA), which the light build leaves out.
import type Hls from 'hls.js'

export interface ScriptedHls {
  // hls.js is loaded and this browser can use it. Loading starts on the first call.
  ready(): boolean
  attach(element: HTMLMediaElement, url: string, onFatal: () => void): void
  // Stops and forgets the element's hls.js instance; true if it had one.
  detach(element: HTMLMediaElement): boolean
}

type HlsModule = typeof import('hls.js')

export function createScriptedHls(load: () => Promise<HlsModule> = () => import('hls.js')): ScriptedHls {
  let module: HlsModule | null = null
  let loading = false
  const instances = new WeakMap<HTMLMediaElement, Hls>()
  const supported = () => typeof window !== 'undefined' && (typeof window.MediaSource !== 'undefined' || 'ManagedMediaSource' in window)

  return {
    ready() {
      if (module) return module.default.isSupported()
      if (!loading && supported()) {
        loading = true
        load().then((loaded) => { module = loaded }, () => { loading = false })
      }
      return false
    },
    attach(element, url, onFatal) {
      this.detach(element)
      if (!module) throw new Error('hls.js is not loaded')
      const HlsClass = module.default
      const hls = new HlsClass({
        // The Worker re-signs every playlist; segments are byte ranges of one file per stream.
        enableWorker: true,
        backBufferLength: 60,
        maxBufferLength: 30,
        // Start from the connection's measured speed rather than the lowest variant.
        testBandwidth: true,
        startLevel: -1,
        capLevelToPlayerSize: false,
      })
      let recoveredMedia = false
      hls.on(HlsClass.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        // A decoder hiccup is worth one in-place recovery; anything else goes to the player's retry
        // and fallback (HLS twice, then the single MP4 file).
        if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
          recoveredMedia = true
          hls.recoverMediaError()
          return
        }
        onFatal()
      })
      instances.set(element, hls)
      hls.attachMedia(element)
      hls.loadSource(url)
    },
    detach(element) {
      const hls = instances.get(element)
      if (!hls) return false
      instances.delete(element)
      hls.destroy()
      return true
    },
  }
}
