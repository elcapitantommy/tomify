import { useState } from 'react'
import { Heart } from 'lucide-react'
import { useApi } from '../lib/api-context'
import type { StarKind } from '../lib/navidrome'
import { isStarred, useFavourites } from '../stores/favourites'

// Optimistic heart toggle: flips at once, then reverts if the music server refuses.
export function StarButton({ item, kind, name, className = 'icon-button star-toggle' }: { item: { id: string; starred?: string }; kind: StarKind; name: string; className?: string }) {
  const api = useApi()
  const starred = useFavourites((s) => isStarred(s.overrides, item))
  const setStarred = useFavourites((s) => s.setStarred)
  const confirm = useFavourites((s) => s.confirm)
  const [pending, setPending] = useState(false)

  async function toggle() {
    if (pending) return
    const next = !starred
    setStarred(item.id, next)
    setPending(true)
    try {
      await (next ? api.star(item.id, kind) : api.unstar(item.id, kind))
      confirm()
    } catch (error) {
      console.error('Could not update favourite', error)
      setStarred(item.id, starred)
    } finally {
      setPending(false)
    }
  }

  const label = starred ? `Remove ${name} from favourites` : `Add ${name} to favourites`
  return <button type="button" className={starred ? `${className} starred` : className} onClick={() => void toggle()} aria-label={label} aria-busy={pending} title={label}><Heart fill={starred ? 'currentColor' : 'none'}/></button>
}
