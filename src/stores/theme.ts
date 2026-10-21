import { create } from 'zustand'

export type ThemeMode = 'system' | 'dark' | 'light'
const KEY = 'tomify-theme'
// Must match the light theme's background (scripts/light-theme.mjs maps --bg) and index.html.
const BAR_COLOURS = { dark: '#0d0f0e', light: '#f0f2f1' }

function savedMode(): ThemeMode {
  try { const value = window.localStorage.getItem(KEY); return value === 'dark' || value === 'light' ? value : 'system' } catch { return 'system' }
}

const prefersLight = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches

export function resolveTheme(mode: ThemeMode, systemLight = prefersLight()): 'dark' | 'light' {
  return mode === 'system' ? (systemLight ? 'light' : 'dark') : mode
}

// Sets data-theme on <html> (styles.css has the light rules under :root[data-theme=light]) and the browser bar colour.
export function applyTheme(mode: ThemeMode) {
  const theme = resolveTheme(mode)
  document.documentElement.setAttribute('data-theme', theme)
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', BAR_COLOURS[theme])
}

export const useTheme = create<{ mode: ThemeMode; setMode(mode: ThemeMode): void }>()((set) => ({
  mode: savedMode(),
  setMode: (mode) => {
    try { window.localStorage.setItem(KEY, mode) } catch { /* storage unavailable */ }
    set({ mode })
    applyTheme(mode)
  },
}))

// Follows the phone or computer switching between light and dark while Tomify is open.
export function watchSystemTheme() {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia('(prefers-color-scheme: light)')
  const change = () => { if (useTheme.getState().mode === 'system') applyTheme('system') }
  query.addEventListener?.('change', change)
  return () => query.removeEventListener?.('change', change)
}
