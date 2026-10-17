import { AudioWaveform } from 'lucide-react'
import { STREAM_QUALITY_OPTIONS, useStreamQuality } from '../stores/streamQuality'

/** Per-device choice between adaptive streaming and original files. Applies from the next track. */
export function StreamingQuality() {
  const quality = useStreamQuality((state) => state.quality)
  const setQuality = useStreamQuality((state) => state.setQuality)
  return <fieldset className="streaming-quality">
    <legend><AudioWaveform/>Streaming quality</legend>
    {STREAM_QUALITY_OPTIONS.map((option) => <label key={option.value}>
      <input type="radio" name="streaming-quality" value={option.value} checked={quality === option.value} onChange={() => setQuality(option.value)}/>
      <span><strong>{option.label}</strong><small>{option.detail}</small></span>
    </label>)}
    <p>Applies from the next track, on this device only.</p>
  </fieldset>
}
