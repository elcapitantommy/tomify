// Tomify for Windows (desktop/) shows this site in its own window and gives it window.__TAURI__.
// Only the commands granted in desktop/src-tauri/capabilities/tomify-site.json work from here.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export function desktopApp(): { invoke: Invoke } | null {
  if (typeof window === 'undefined') return null
  const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke
  return typeof invoke === 'function' ? { invoke } : null
}
