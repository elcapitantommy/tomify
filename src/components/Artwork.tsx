import { useState } from 'react'
import { Disc3, UserRound } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { initials } from '../lib/format'
import { albumArtworkUrl, useAlbumArtwork } from '../stores/albumArtwork'

export function Artwork({ id, albumId, alt, className = '', round = false, size = 600 }: { id?: string; albumId?: string; alt: string; className?: string; round?: boolean; size?: number }) {
  const api = useApi(); const [failed, setFailed] = useState<string[]>([])
  const override = useAlbumArtwork((state) => albumId ? albumArtworkUrl(state.overrides[albumId]) : undefined)
  // A replacement image that fails to load falls back to the library's own artwork.
  const url = [override, api.coverArtUrl(id, size)].find((value) => value && !failed.includes(value))
  return <div className={`artwork ${round ? 'round' : ''} ${className}`}>{url ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed((current) => [...current, url])} /> : <div className="artwork-fallback" aria-label={`${alt} artwork unavailable`}>{round ? <><UserRound /><span>{initials(alt)}</span></> : <Disc3 />}</div>}</div>
}
