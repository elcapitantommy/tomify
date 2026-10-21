import { useEffect, useState } from 'react'
import { CalendarHeart } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Album } from '../types'
import { useApi } from '../lib/api-context'
import { AlbumCard } from './MediaCards'
import { ArtistLinks } from './ArtistLinks'
import { listeningStatsApi, type StatsRow } from '../lib/listening-stats'
import { anniversaries, anniversaryLabel, dayKey, dayLastYear, type Anniversary } from '../lib/on-this-day'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { usePlayer } from '../stores/player'

const CACHE_KEY = 'tomify-on-this-day'
const MAX_ANNIVERSARIES = 6

interface Cached { day: string; albums: Album[] }
function cachedAlbums(day: string): Album[] | null {
  try { const value = JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null') as Cached | null; return value?.day === day ? value.albums : null } catch { return null }
}

// Home section: albums released on this date in earlier years, and what you played on this day a year ago.
export function OnThisDay({ today = new Date() }: { today?: Date }) {
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const [albums, setAlbums] = useState<Album[] | null>(() => cachedAlbums(dayKey(today)))
  const [lastYear, setLastYear] = useState<StatsRow[]>([])
  const day = dayKey(today)

  useEffect(() => {
    if (albums) return
    const controller = new AbortController()
    // The whole library is read once a day; the albums from it are kept until tomorrow.
    api.allAlbums(controller.signal).then((all) => {
      const found = anniversaries(all, today).map((item) => item.album)
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify({ day, albums: found })) } catch { /* storage unavailable */ }
      setAlbums(found)
    }).catch(() => { if (!controller.signal.aborted) setAlbums([]) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, day])

  useEffect(() => {
    let active = true
    listeningStatsApi.load(dayLastYear(today)).then((stats) => { if (active) setLastYear(stats.albums.slice(0, 6)) }).catch(() => undefined)
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

  const found: Anniversary[] = anniversaries(albums ?? [], today, overrides).slice(0, MAX_ANNIVERSARIES)
  if (!found.length && !lastYear.length) return null
  const playAlbum = async (id: string) => { const album = await api.album(id); usePlayer.getState().playTracks(album.song ?? []) }

  return <section className="on-this-day" aria-label="On this day">
    <div className="section-title"><div><span className="eyebrow">{today.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</span><h2><CalendarHeart/>On this day</h2></div></div>
    {found.length > 0 && <div className="card-grid">{found.map(({ album, years }) => <AlbumCard key={album.id} album={album} dateLabel={anniversaryLabel(years)} onPlay={() => void playAlbum(album.id)}/>)}</div>}
    {lastYear.length > 0 && <div className="on-this-day-last-year"><h3>A year ago today you were playing</h3><ul>{lastYear.map((row) => <li key={row.albumId ?? row.album ?? ''}>{row.albumId ? <Link to={`/albums/${row.albumId}`}>{row.album}</Link> : row.album}<small> · <ArtistLinks name={row.artist} artistId={row.artistId}/></small></li>)}</ul></div>}
  </section>
}
