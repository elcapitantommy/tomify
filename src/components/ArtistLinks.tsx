import { Fragment, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { artistSegments } from '../lib/artist-links'
import type { ArtistRef } from '../types'

// An artist line where each artist links to their page. Pass `onNavigate` to close an overlay
// (Now Playing, the queue) when a link is followed.
export function ArtistLinks({ name, artists, artistId, onNavigate, className = 'artist-links' }: { name?: string | null; artists?: ArtistRef[]; artistId?: string | null; onNavigate?: () => void; className?: string }) {
  const segments = artistSegments(name, artists, artistId)
  if (!segments.length) return null
  const follow = (event: MouseEvent) => { event.stopPropagation(); onNavigate?.() }
  return <span className={className}>{segments.map((segment, index) => segment.id
    ? <Link key={index} to={`/artists/${encodeURIComponent(segment.id)}`} onClick={follow}>{segment.text}</Link>
    : <Fragment key={index}>{segment.text}</Fragment>)}</span>
}

// The same for anything shaped like a song or album.
export function ItemArtists({ item, onNavigate, className }: { item: { artist?: string | null; artistId?: string | null; artists?: ArtistRef[] }; onNavigate?: () => void; className?: string }) {
  return <ArtistLinks name={item.artist} artists={item.artists} artistId={item.artistId} onNavigate={onNavigate} className={className}/>
}
