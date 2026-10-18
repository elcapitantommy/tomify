import { SlidersHorizontal } from 'lucide-react'
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESETS, bandLabel, equaliserSupported } from '../lib/equaliser'
import { streamsFromThisOrigin } from '../lib/navidrome'
import { useAuth } from '../stores/auth'
import { useEqualiser } from '../stores/equaliser'

/** Per-device ten-band equaliser. Hidden where Web Audio would break background playback (iPhone, iPad). */
export function Equaliser({ supported = equaliserSupported() }: { supported?: boolean }) {
  const serverUrl = useAuth((state) => state.session?.serverUrl)
  const { enabled, preset, gains, setEnabled, choosePreset, setBand } = useEqualiser()
  if (!supported || !serverUrl || !streamsFromThisOrigin(serverUrl)) {
    const reason = supported ? 'Only available with the Tomify music server.' : 'Not available on iPhone or iPad: it would stop music playing when the screen locks.'
    return <div className="setting-row"><SlidersHorizontal/><span><strong>Equaliser</strong><small>{reason}</small></span></div>
  }
  return <fieldset className="streaming-quality equaliser">
    <legend><SlidersHorizontal/>Equaliser</legend>
    <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>Use the equaliser</strong><small>On this device only.</small></span></label>
    {enabled && <>
      <label className="equaliser-preset"><span><strong>Preset</strong></span>
        <select value={preset} onChange={(event) => { if (event.target.value !== 'custom') choosePreset(event.target.value as Exclude<typeof preset, 'custom'>) }}>
          {EQ_PRESETS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          {preset === 'custom' && <option value="custom">Custom</option>}
        </select>
      </label>
      <div className="equaliser-bands">
        {EQ_BANDS.map((frequency, index) => <label key={frequency}>
          <span>{bandLabel(frequency)}</span>
          <input type="range" aria-label={`${bandLabel(frequency)} gain`} min={-EQ_MAX_DB} max={EQ_MAX_DB} step="1" value={gains[index] ?? 0} onChange={(event) => setBand(index, Number(event.target.value))}/>
          <output>{(gains[index] ?? 0) > 0 ? '+' : ''}{gains[index] ?? 0} dB</output>
        </label>)}
      </div>
    </>}
  </fieldset>
}
