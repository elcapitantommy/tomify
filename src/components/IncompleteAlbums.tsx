import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { completenessApi, type IncompleteAlbum } from '../lib/completeness-api'

// Albums whose last completeness check came up short. Counts are from that check, so the album page has the live answer.
export function IncompleteAlbums() {
  const [albums, setAlbums] = useState<IncompleteAlbum[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    completenessApi.overview(controller.signal).then((result) => setAlbums(result.albums)).catch((cause: Error) => { if (cause.name !== 'AbortError') setError(cause.message) })
    return () => controller.abort()
  }, [])

  const entries = albums ?? []
  return <details className="health-category" open={entries.length > 0}><summary><span>Incomplete albums</span><strong>{entries.length}</strong></summary>
    {error ? <p className="health-empty">Album completeness is unavailable: {error}</p>
      : !albums ? <p className="health-empty">Loading checked albums…</p>
      : entries.length === 0 ? <p className="health-empty">Every album checked against MusicBrainz was complete. Check an album from its page.</p>
      : <ul>{entries.map((album) => <li key={album.albumId}>
        <div><strong>{album.artist ? `${album.artist} · ${album.title}` : album.title}</strong>
          <small>{album.present} of {album.total} tracks when checked {new Date(album.checkedAt.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(album.checkedAt) ? '' : 'Z')).toLocaleDateString()}{album.queued ? ` · ${album.queued} in Recovery` : ''}</small></div>
        <span className="health-actions"><Link to={`/albums/${encodeURIComponent(album.albumId)}`} aria-label={`Open ${album.title}`} title={`Open ${album.title}`}><ExternalLink/></Link></span>
      </li>)}</ul>}
  </details>
}
