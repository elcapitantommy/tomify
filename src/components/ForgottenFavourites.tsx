import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import type { Album } from '../types'
import { useApi } from '../lib/api-context'
import { forgottenAlbums, lastPlayedLabel } from '../lib/forgotten'
import { usePlayer } from '../stores/player'
import { AlbumCard } from './MediaCards'

// Home section: albums with plenty of plays that haven't been played for six months or more.
// Navidrome's most-played list carries each album's play count and when it was last played.
export function ForgottenFavourites({ now = new Date() }: { now?: Date }) {
  const api = useApi()
  const [albums, setAlbums] = useState<Album[]>([])
  const day = now.toDateString()
  useEffect(() => {
    const controller = new AbortController()
    api.albums('frequent', 300, controller.signal).then((list) => setAlbums(forgottenAlbums(list, now))).catch(() => undefined)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, day])
  if (!albums.length) return null
  const playAlbum = async (id: string) => { const album = await api.album(id); usePlayer.getState().playTracks(album.song ?? []) }
  return <section className="forgotten-favourites" aria-label="Forgotten favourites">
    <div className="section-title"><div><span className="eyebrow">Haven't heard these in a while</span><h2><History/>Forgotten favourites</h2></div></div>
    <div className="card-grid">{albums.map((album) => <AlbumCard key={album.id} album={album} dateLabel={lastPlayedLabel(album.played)} onPlay={() => void playAlbum(album.id)}/>)}</div>
  </section>
}
