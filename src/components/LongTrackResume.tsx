import { useEffect } from 'react'
import { useOptionalApi } from '../lib/api-context'
import { followPlayer } from '../lib/long-track-resume'
import { useBookmarks } from '../stores/bookmarks'

// Keeps this device's place in long tracks as Navidrome bookmarks, and picks up from a saved place
// when one starts. It only follows this device's own player, so the device actually playing does the saving.
export function LongTrackResume() {
  const api = useOptionalApi()
  useEffect(() => {
    if (!api) return
    void useBookmarks.getState().load(api).catch(() => undefined)
    return followPlayer(api)
  }, [api])
  return null
}
