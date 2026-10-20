import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import type { Artist } from '../types'
import { ArtistCard } from './MediaCards'
import { TrackList } from './TrackList'

const POPULAR_SHORT = 5

// Popular songs, biography and similar artists for an artist page come from Navidrome's Last.fm
// agent. Each part is simply left out when Navidrome has nothing (no agent, or an unknown artist).
function quiet<T>(promise: Promise<T>, fallback: T) {
  return promise.catch((error: unknown) => { if (error instanceof DOMException && error.name === 'AbortError') throw error; return fallback })
}

export function ArtistPopular({ artist }: { artist: Artist }) {
  const api = useApi()
  const [allPopular, setAllPopular] = useState(false)
  const { data: popular } = useLoad((signal) => quiet(api.topSongs(artist.name, 10, signal), []), [api, artist.name], `artist-top:${api.session.username}:${artist.id}`)
  const shown = allPopular ? popular ?? [] : (popular ?? []).slice(0, POPULAR_SHORT)
  if (!shown.length) return null
  return <section className="artist-popular"><div className="section-title"><h2>Popular</h2>{(popular?.length ?? 0) > POPULAR_SHORT && <button type="button" className="text-button" onClick={() => setAllPopular(!allPopular)}>{allPopular ? 'Show less' : 'Show more'}</button>}</div><TrackList tracks={shown}/></section>
}

export function ArtistAbout({ artist }: { artist: Artist }) {
  const api = useApi()
  const [bioOpen, setBioOpen] = useState(false)
  const { data: info } = useLoad((signal) => quiet(api.artistInfo(artist.id, signal), null), [api, artist.id], `artist-info:${api.session.username}:${artist.id}`)
  const bio = info?.biography ?? []
  return <>
    {bio.length > 0 && <section className="artist-bio"><div className="section-title"><h2>About</h2></div><div className={bioOpen ? 'artist-bio-text open' : 'artist-bio-text'}>{(bioOpen ? bio : bio.slice(0, 1)).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div><div className="artist-bio-actions">{(bio.length > 1 || bio[0].length > 360) && <button type="button" className="text-button" onClick={() => setBioOpen(!bioOpen)} aria-expanded={bioOpen}>{bioOpen ? 'Show less' : 'Read more'}</button>}{info?.lastFmUrl && <a className="text-button" href={info.lastFmUrl} target="_blank" rel="noreferrer">Last.fm<ExternalLink size={13}/></a>}</div></section>}
    {(info?.similar.length ?? 0) > 0 && <section className="artist-similar"><div className="section-title"><div><span className="eyebrow">In your library</span><h2>Fans also like</h2></div></div><div className="card-grid compact">{info!.similar.map((item) => <ArtistCard artist={item} key={item.id}/>)}</div></section>}
  </>
}
