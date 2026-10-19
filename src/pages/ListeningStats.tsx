import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { listeningStatsApi, type StatsRow } from '../lib/listening-stats'

const periods: [number, string][] = [[7, 'Last 7 days'], [30, 'Last 30 days'], [365, 'Last year']]
const hours = (seconds: number) => seconds >= 3600 ? `${(seconds / 3600).toFixed(seconds >= 36000 ? 0 : 1)} hours` : `${Math.round(seconds / 60)} minutes`

// Tomify's own listening history: what you played most, from what the player reports at the end of each track.
export function ListeningStats() {
  const [days, setDays] = useState(30)
  const { data, loading, error, retry } = useLoad(() => listeningStatsApi.load(days), [days])
  const top = (title: string, rows: StatsRow[], label: (row: StatsRow) => React.ReactNode) => <section className="stats-list"><h2>{title}</h2>{rows.length ? <ol>{rows.map((row, index) => <li key={index}><span>{label(row)}</span><small>{row.plays} {row.plays === 1 ? 'play' : 'plays'}</small></li>)}</ol> : <p className="health-empty">Nothing yet.</p>}</section>
  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow"><BarChart3 size={14}/> Your library</span><h1>Listening stats</h1><p>From the plays Tomify records on every device.</p></header>
    <div className="stats-periods" role="group" aria-label="Period">{periods.map(([value, label]) => <button key={value} className={value === days ? 'button primary' : 'button secondary'} aria-pressed={value === days} onClick={() => setDays(value)}>{label}</button>)}</div>
    {loading && <SkeletonGrid/>}{error && <ErrorState message={error} retry={retry}/>}
    {data && !data.plays && <EmptyState title="No plays yet" message="Play some music and your stats will build up here."/>}
    {data && data.plays > 0 && <>
      <div className="stats-totals"><div><strong>{data.plays}</strong><small>plays</small></div><div><strong>{hours(data.seconds)}</strong><small>listened</small></div><div><strong>{Math.round((data.skips / data.plays) * 100)}%</strong><small>skipped</small></div></div>
      {top('Top artists', data.artists, (row) => row.artistId ? <Link to={`/artists/${row.artistId}`}>{row.artist}</Link> : row.artist)}
      {top('Top albums', data.albums, (row) => <><Link to={`/albums/${row.albumId}`}>{row.album}</Link><small> · {row.artist}</small></>)}
      {top('Top tracks', data.tracks, (row) => <>{row.albumId ? <Link to={`/albums/${row.albumId}`}>{row.title}</Link> : row.title}<small> · {row.artist}</small></>)}
    </>}
  </div>
}
