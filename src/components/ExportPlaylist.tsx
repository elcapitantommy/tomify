import { FileDown } from 'lucide-react'
import { downloadM3u } from '../lib/m3u'
import type { Track } from '../types'

// Saves the playlist as an .m3u8 file for other players (see lib/m3u.ts).
export function ExportPlaylistButton({ name, tracks }: { name: string; tracks: Track[] }) {
  if (!tracks.length) return null
  return <button type="button" className="button secondary" onClick={() => downloadM3u(name, tracks)} title="Save as an M3U playlist file"><FileDown/>Export</button>
}
