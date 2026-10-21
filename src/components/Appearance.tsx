import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemeMode } from '../stores/theme'

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: typeof Sun }> = [
  { mode: 'system', label: 'Automatic', icon: Monitor },
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
]

// Settings card: light, dark, or follow the device (the default). Kept per device.
export function Appearance() {
  const mode = useTheme((state) => state.mode)
  return <section className="settings-card appearance-card"><h2>Appearance</h2>
    <div className="theme-options" role="radiogroup" aria-label="Theme">{OPTIONS.map(({ mode: value, label, icon: Icon }) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'button primary' : 'button secondary'} onClick={() => useTheme.getState().setMode(value)}><Icon/>{label}</button>)}</div>
    <p className="settings-note">Automatic follows your phone or computer's light or dark setting. This is saved on this device only.</p>
  </section>
}
