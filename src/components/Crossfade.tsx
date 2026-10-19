import { Blend } from 'lucide-react'
import { MAX_CROSSFADE_SECONDS, useCrossfade } from '../stores/crossfade'
import { volumeCanFade } from '../lib/crossfade'

/** Per-device crossfade between songs; off plays them gapless. */
export function Crossfade() {
  const seconds = useCrossfade((state) => state.seconds)
  const setSeconds = useCrossfade((state) => state.setSeconds)
  const label = seconds ? `${seconds} second${seconds === 1 ? '' : 's'}` : 'Off'
  return <fieldset className="streaming-quality crossfade-setting">
    <legend><Blend/>Crossfade</legend>
    <label>
      <span><strong>{label}</strong><small>{seconds ? 'The end of each song fades into the start of the next.' : 'Songs play back to back with no gap.'}</small></span>
    </label>
    <input type="range" min="0" max={MAX_CROSSFADE_SECONDS} step="1" value={seconds} aria-label="Crossfade" aria-valuetext={label} onChange={(event) => setSeconds(Number(event.target.value))}/>
    <p>On this device only. Songs that run into each other on an album, and DJ sets, always play gapless.{volumeCanFade() ? '' : ' This browser can’t fade audio (iPhone and iPad), so songs here play gapless instead.'}</p>
  </fieldset>
}
