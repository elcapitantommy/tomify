import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import type { Album, Artist } from '../types'
import { Artwork } from './Artwork'

export function AlbumCard({ album, onPlay }: { album: Album; onPlay?: () => void }) { return <article className="media-card"><Link to={`/albums/${album.id}`}><Artwork id={album.coverArt ?? album.id} alt={album.name}/><h3>{album.name}</h3><p>{album.artist}{album.year ? ` · ${album.year}` : ''}</p></Link>{onPlay && <button className="card-play" onClick={onPlay} aria-label={`Play ${album.name}`}><Play fill="currentColor"/></button>}</article> }
export function ArtistCard({ artist }: { artist: Artist }) { return <article className="media-card artist-card"><Link to={`/artists/${artist.id}`}><Artwork id={artist.coverArt ?? artist.id} alt={artist.name} round/><h3>{artist.name}</h3><p>{artist.albumCount ?? 0} albums</p></Link></article> }
