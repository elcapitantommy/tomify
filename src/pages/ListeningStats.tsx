import { useState } from 'react'
import { BarChart3, Gift } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AlbumLabel, ArtistLabel, StatsList, TrackLabel } from '../components/StatsList'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { calendarPeriod, listenedFor, listeningStatsApi, monthPeriod, type StatsPeriod } from '../lib/listening-stats'

const periods: [string, string][] = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['365', 'Last 12 months']]

function periodFor(key: string): StatsPeriod {
  if (key === 'week' || key === 'month' || key === 'year') return calendarPeriod(key)
  return monthPeriod(key) ?? { days: Number(key) || 30 }
}

// Tomify's own listening history: what you played most, from what the player reports at the end of each track.
export function ListeningStats() {
  const [key, setKey] = useState('30')
  const { data, loading, error, retry } = useLoad(() => listeningStatsApi.load(periodFor(key)), [key])
  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow"><BarChart3 size={14}/> Your library</span><h1>Listening stats</h1><p>From the plays Tomify records on every device.</p></header>
    <div className="stats-periods" role="group" aria-label="Period">{periods.map(([value, label]) => <button key={value} className={value === key ? 'button primary' : 'button secondary'} aria-pressed={value === key} onClick={() => setKey(value)}>{label}</button>)}
      <label className="stats-month">Month <input type="month" aria-label="Choose a month" value={monthPeriod(key) ? key : ''} onChange={(event) => event.target.value && setKey(event.target.value)}/></label></div>
    <p className="stats-wrapped-links"><Link to="/history">See every play in Listening history</Link></p>{data && data.years.length > 0 && <p className="stats-wrapped-links"><Gift size={16}/> Wrapped: {data.years.map((year) => <Link key={year} to={`/wrapped/${year}`}>{year}</Link>)}</p>}
    {loading && <SkeletonGrid/>}{error && <ErrorState message={error} retry={retry}/>}
    {data && !data.plays && <EmptyState title="No plays yet" message="Play some music and your stats will build up here."/>}
    {data && data.plays > 0 && <>
      <div className="stats-totals"><div><strong>{data.plays}</strong><small>plays</small></div><div><strong>{listenedFor(data.seconds)}</strong><small>listened</small></div><div><strong>{Math.round((data.skips / data.plays) * 100)}%</strong><small>skipped</small></div></div>
      <StatsList title="Top artists" rows={data.artists} label={(row) => <ArtistLabel row={row}/>}/>
      <StatsList title="Top albums" rows={data.albums} label={(row) => <AlbumLabel row={row}/>}/>
      <StatsList title="Top tracks" rows={data.tracks} label={(row) => <TrackLabel row={row}/>}/>
      <StatsList title="Top genres" rows={data.genres} label={(row) => row.genre}/>
    </>}
  </div>
}
