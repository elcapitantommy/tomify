import { useState } from 'react'
import { Disc3, UserRound } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { initials } from '../lib/format'

export function Artwork({ id, alt, className = '', round = false, size = 600 }: { id?: string; alt: string; className?: string; round?: boolean; size?: number }) {
  const api = useApi(); const [failed, setFailed] = useState(false); const url = api.coverArtUrl(id, size)
  return <div className={`artwork ${round ? 'round' : ''} ${className}`}>{url && !failed ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <div className="artwork-fallback" aria-label={`${alt} artwork unavailable`}>{round ? <><UserRound /><span>{initials(alt)}</span></> : <Disc3 />}</div>}</div>
}
