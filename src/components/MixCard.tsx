import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import type { Mix } from '../lib/mixes-api'
import { Artwork } from './Artwork'

// Four album covers in a grid, or one cover when the mix has fewer albums.
export function MixCover({ mix, size = 300 }: { mix: Mix; size?: number }) {
  const covers = mix.coverArt.length >= 4 ? mix.coverArt.slice(0, 4) : mix.coverArt.slice(0, 1)
  if (covers.length < 4) return <Artwork id={covers[0]} alt={mix.title} size={size * 2}/>
  return <div className="mix-cover" aria-label={`${mix.title} cover`}>{covers.map((id) => <Artwork key={id} id={id} alt="" size={size}/>)}</div>
}

export function MixCard({ mix, onPlay }: { mix: Mix; onPlay: () => void }) {
  return <article className="media-card mix-card"><Link to={`/mixes/${mix.id}`}><div className="artwork-wrap"><MixCover mix={mix}/></div><h3>{mix.title}</h3><p title={mix.description}>{mix.description}</p></Link><button className="card-play" onClick={onPlay} aria-label={`Play ${mix.title}`} title={`Play ${mix.title}`}><Play fill="currentColor"/></button></article>
}
