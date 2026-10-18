import { Volume2 } from 'lucide-react'
import { NORMALISATION_OPTIONS, useNormalisation } from '../stores/normalisation'

/** Per-device loudness normalisation from the library's ReplayGain tags. */
export function Normalisation() {
  const setting = useNormalisation((state) => state.setting)
  const setSetting = useNormalisation((state) => state.setSetting)
  return <fieldset className="streaming-quality">
    <legend><Volume2/>Volume normalisation</legend>
    {NORMALISATION_OPTIONS.map((option) => <label key={option.value}>
      <input type="radio" name="normalisation" value={option.value} checked={setting === option.value} onChange={() => setSetting(option.value)}/>
      <span><strong>{option.label}</strong><small>{option.detail}</small></span>
    </label>)}
    <p>On this device only. Songs without loudness tags play as they are. On iPhone it needs adaptive streaming, so it doesn’t apply with Always original.</p>
  </fieldset>
}
