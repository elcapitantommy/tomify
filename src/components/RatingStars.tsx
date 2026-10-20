import { useState } from 'react'
import { Star } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { nextRating, ratingOf, useRatings } from '../stores/ratings'

// Five stars for a song or album. Changes show at once and roll back if the music server refuses.
// Smart playlists can filter on these ("Rating at least").
export function RatingStars({ item, name, className = '' }: { item: { id: string; userRating?: number }; name: string; className?: string }) {
  const api = useApi()
  const rating = useRatings((state) => ratingOf(state.overrides, item))
  const setRating = useRatings((state) => state.setRating)
  const [hover, setHover] = useState(0)
  const [pending, setPending] = useState(false)

  async function rate(picked: number) {
    if (pending) return
    const next = nextRating(rating, picked)
    setRating(item.id, next)
    setPending(true)
    try {
      await api.setRating(item.id, next)
    } catch (error) {
      console.error('Could not save rating', error)
      setRating(item.id, rating)
    } finally {
      setPending(false)
    }
  }

  const shown = hover || rating
  return <span className={`rating-stars ${className}`.trim()} role="group" aria-label={`Rating for ${name}: ${rating ? `${rating} of 5 stars` : 'not rated'}`} aria-busy={pending} onMouseLeave={() => setHover(0)}>
    {[1, 2, 3, 4, 5].map((stars) => <button key={stars} type="button" className={stars <= shown ? 'lit' : undefined} onMouseEnter={() => setHover(stars)} onFocus={() => setHover(stars)} onBlur={() => setHover(0)} onClick={() => void rate(stars)} aria-pressed={stars === rating} aria-label={stars === rating ? `Clear rating for ${name}` : `Rate ${name} ${stars} ${stars === 1 ? 'star' : 'stars'}`} title={stars === rating ? 'Clear rating' : `${stars} ${stars === 1 ? 'star' : 'stars'}`}><Star fill={stars <= shown ? 'currentColor' : 'none'}/></button>)}
  </span>
}
