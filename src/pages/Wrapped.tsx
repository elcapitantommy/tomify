import { useState } from 'react'
import { Gift, ListPlus } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { AlbumLabel, ArtistLabel, StatsList, TrackLabel } from '../components/StatsList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { listenedFor, listeningStatsApi, type WrappedTrack } from '../lib/listening-stats'

const monthName = (month: number) => new Date(2000, month - 1, 1).toLocaleString(undefined, { month: 'long' })
const minutes = (seconds: number) => Math.round(seconds / 60).toLocaleString()

function Moment({ title, track, detail }: { title: string; track: WrappedTrack | null; detail?: string }) {
  if (!track) return null
  return <div className="wrapped-moment"><small>{title}</small><strong>{track.albumId ? <Link to={`/albums/${track.albumId}`}>{track.title}</Link> : track.title}</strong><span>{track.artist}{detail ? ` · ${detail}` : ''}</span></div>
}

// A year in review from Tomify's own listening history, like Spotify Wrapped.
export function Wrapped() {
  const api = useApi()
  const year = Number(useParams().year)
  const [saved, setSaved] = useState<string | null>(null)
  const { data, loading, error, retry } = useLoad(() => listeningStatsApi.wrapped(year), [year])
  const save = async () => {
    if (!data) return
    setSaved('Saving…')
    try { await api.createPlaylist(`Your ${year} in Tomify`, data.playlist); setSaved('Saved to your playlists') } catch (reason) { setSaved(reason instanceof Error ? reason.message : 'Could not save the playlist.') }
  }
  const header = <header className="page-header"><span className="eyebrow"><Gift size={14}/> Wrapped</span><h1>Your {year}</h1><p>Your year in music, from the plays Tomify recorded on every device.</p></header>
  if (loading) return <div className="page narrow-page">{header}<SkeletonGrid/></div>
  if (error) return <div className="page narrow-page">{header}<ErrorState message={error} retry={retry}/></div>
  if (!data?.plays) return <div className="page narrow-page">{header}<EmptyState title={`No plays in ${year}`} message="Play some music and your year will build up here."/></div>
  const busiest = [...data.months].sort((a, b) => b.seconds - a.seconds)[0]
  const longest = Math.max(...data.months.map((month) => month.seconds), 1)
  const change = data.previous?.seconds ? Math.round(((data.seconds - data.previous.seconds) / data.previous.seconds) * 100) : null
  return <div className="page narrow-page wrapped-page">{header}
    <div className="stats-totals">
      <div><strong>{minutes(data.seconds)}</strong><small>minutes listened</small></div>
      <div><strong>{data.plays.toLocaleString()}</strong><small>plays</small></div>
      <div><strong>{data.newArtistCount}</strong><small>new artists</small></div>
    </div>
    {change !== null && data.previous && <p className="wrapped-compare">{change === 0 ? `The same amount of listening as ${data.previous.year}.` : `${Math.abs(change)}% ${change > 0 ? 'more' : 'less'} listening than ${data.previous.year} (${listenedFor(data.previous.seconds)}).`}</p>}
    {busiest && <section className="wrapped-months" aria-label="Listening by month"><h2>Your biggest month was {monthName(busiest.month)}</h2><p>{listenedFor(busiest.seconds)} of music.</p>
      <ol>{Array.from({ length: 12 }, (_, index) => { const month = data.months.find((row) => row.month === index + 1); return <li key={index} title={`${monthName(index + 1)}: ${listenedFor(month?.seconds ?? 0)}`}><span style={{ height: `${Math.round(((month?.seconds ?? 0) / longest) * 100)}%` }} className={month === busiest ? 'busiest' : undefined}/><small>{monthName(index + 1).slice(0, 1)}</small></li> })}</ol></section>}
    <div className="wrapped-moments">
      <Moment title="First song of the year" track={data.firstTrack} detail={data.firstTrack?.playedAt ? new Date(data.firstTrack.playedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : undefined}/>
      <Moment title="Most on repeat" track={data.mostRepeated} detail={data.mostRepeated?.plays && data.mostRepeated.day ? `${data.mostRepeated.plays} plays on ${new Date(`${data.mostRepeated.day}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` : undefined}/>
    </div>
    <StatsList title="Top artists" rows={data.artists} label={(row) => <ArtistLabel row={row}/>}/>
    <StatsList title="Top albums" rows={data.albums} label={(row) => <AlbumLabel row={row}/>}/>
    <StatsList title="Top tracks" rows={data.tracks} label={(row) => <TrackLabel row={row}/>}/>
    <StatsList title="Top genres" rows={data.genres} label={(row) => row.genre}/>
    {data.newArtists.length > 0 && <StatsList title="New to you this year" rows={data.newArtists} label={(row) => <ArtistLabel row={row}/>}/>}
    {data.playlist.length > 0 && <section className="wrapped-playlist"><h2>Your {year} playlist</h2><p>Your {data.playlist.length} most played songs of the year.</p><button className="button primary" onClick={() => void save()} disabled={saved === 'Saving…' || saved === 'Saved to your playlists'}><ListPlus/>Save as playlist</button>{saved && <p role="status">{saved}</p>}</section>}
  </div>
}
