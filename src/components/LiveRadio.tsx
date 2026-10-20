import { useEffect, useRef } from 'react'
import { Radio, Square } from 'lucide-react'
import { AdaptiveSources, loadHlsLibrary } from '../lib/adaptiveStream'
import { isHlsStream } from '../lib/internet-radio'
import { useLiveRadio } from '../stores/liveRadio'
import { usePlayer } from '../stores/player'

// Plays the chosen station and keeps it and the music player from playing over each other.
export function LiveRadioRuntime() {
  const audio = useRef<HTMLAudioElement>(null)
  const sources = useRef(new AdaptiveSources())
  const station = useLiveRadio((state) => state.station)
  const musicPlaying = usePlayer((state) => state.playing)

  useEffect(() => { if (musicPlaying && useLiveRadio.getState().station) useLiveRadio.getState().stop() }, [musicPlaying])

  useEffect(() => {
    const element = audio.current
    if (!element) return
    if (!station) {
      element.pause()
      sources.current.detach(element)
      element.removeAttribute('src')
      return
    }
    let cancelled = false
    if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false)
    const hls = isHlsStream(station.streamUrl)
    void (hls ? loadHlsLibrary() : Promise.resolve()).then(() => {
      if (cancelled) return
      sources.current.attach(element, { kind: hls ? 'hls' : 'direct', url: station.streamUrl }, { preload: 'auto', onFatal: () => useLiveRadio.getState().setStatus('error', 'The station stopped sending audio.') })
      element.play().catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
        useLiveRadio.getState().setStatus('error', 'This station would not play. It may be off air, or need a different link.')
      })
    }).catch(() => useLiveRadio.getState().setStatus('error', 'This station would not play.'))
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: 'Live radio', album: 'Tomify' })
    return () => { cancelled = true }
  }, [station])

  return <audio ref={audio} playsInline x-webkit-airplay="allow"
    onPlaying={() => useLiveRadio.getState().setStatus('playing')}
    onWaiting={() => { if (useLiveRadio.getState().station) useLiveRadio.getState().setStatus('loading') }}
    onError={() => { if (useLiveRadio.getState().station) useLiveRadio.getState().setStatus('error', 'This station would not play. It may be off air, or need a different link.') }}/>
}

// Takes the player bar's place while a station plays.
export function LiveRadioBar() {
  const { station, status, error, stop } = useLiveRadio()
  if (!station) return null
  return <div className="player-bar radio-bar" role="region" aria-label="Live radio">
    <div className="radio-now"><span className="radio-icon"><Radio/></span><span><strong>{station.name}</strong><small>{status === 'error' ? error : status === 'loading' ? 'Tuning in…' : 'Live radio'}</small></span></div>
    <div className="radio-live-dot" aria-hidden="true">{status === 'playing' && <><i/>LIVE</>}</div>
    <div className="player-actions"><button type="button" className="button secondary" onClick={stop} aria-label={`Stop ${station.name}`}><Square fill="currentColor"/>Stop</button></div>
  </div>
}
