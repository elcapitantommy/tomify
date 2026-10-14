import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import type { Album, Artist } from '../types'
import { Artwork } from './Artwork'

export function AlbumCard({ album, onPlay, dateLabel, variantCount = 1, displayTitle }: { album: Album; onPlay?: () => void; dateLabel?: string; variantCount?: number; displayTitle?: string }) { return <article className="media-card"><Link to={`/albums/${album.id}`}><div className="artwork-wrap"><Artwork id={album.coverArt ?? album.id} alt={album.name}/>{variantCount > 1 && <span className="variant-badge">{variantCount} editions</span>}</div><h3>{displayTitle ?? album.name}</h3><p>{album.artist}{dateLabel ? ` · ${dateLabel}` : album.year ? ` · ${album.year}` : ''}</p></Link>{onPlay && <button className="card-play" onClick={onPlay} aria-label={`Play ${album.name}`}><Play fill="currentColor"/></button>}</article> }
export function ArtistCard({ artist }: { artist: Artist }) { return <article className="media-card artist-card"><Link to={`/artists/${artist.id}`}><Artwork id={artist.coverArt ?? artist.id} alt={artist.name} round/><h3>{artist.name}</h3><p>{artist.albumCount ?? 0} albums</p></Link></article> }
