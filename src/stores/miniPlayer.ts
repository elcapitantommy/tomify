import { create } from 'zustand'

// The pop-out mini player: a small always-on-top window (Chrome's Document Picture-in-Picture).
// The window is opened here and Tomify renders into it from components/MiniPlayer.tsx.

interface DocumentPictureInPicture { requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>; window: Window | null }
const pictureInPicture = () => (typeof window === 'undefined' ? undefined : (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture)

export function miniPlayerSupported() { return Boolean(pictureInPicture()) }

// The page's styles, copied so the mini player looks like the rest of Tomify (light theme included).
export function copyStyles(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style')
      style.textContent = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n')
      to.head.append(style)
    } catch {
      // A sheet from another origin (fonts) can't be read; link to it instead.
      if (!sheet.href) continue
      const link = to.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      to.head.append(link)
    }
  }
  const theme = from.documentElement.getAttribute('data-theme')
  if (theme) to.documentElement.setAttribute('data-theme', theme)
}

interface MiniPlayerState {
  window: Window | null
  open(): Promise<void>
  close(): void
}

export const useMiniPlayer = create<MiniPlayerState>()((set, get) => ({
  window: null,
  // Must run from a click: the browser only opens the window for a user gesture.
  open: async () => {
    const api = pictureInPicture()
    if (!api || get().window) return
    const opened = await api.requestWindow({ width: 360, height: 168 })
    copyStyles(document, opened.document)
    opened.document.title = 'Tomify'
    opened.document.body.classList.add('mini-player-window')
    opened.addEventListener('pagehide', () => { if (get().window === opened) set({ window: null }) })
    set({ window: opened })
  },
  close: () => { get().window?.close(); set({ window: null }) },
}))
