import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { StatsRow } from '../lib/listening-stats'

// A numbered top list (artists, albums, tracks or genres) with play counts, shared by the stats and Wrapped pages.
export function StatsList({ title, rows, label }: { title: string; rows: StatsRow[]; label: (row: StatsRow) => ReactNode }) {
  return <section className="stats-list"><h2>{title}</h2>{rows.length ? <ol>{rows.map((row, index) => <li key={index}><span>{label(row)}</span><small>{row.plays} {row.plays === 1 ? 'play' : 'plays'}</small></li>)}</ol> : <p className="health-empty">Nothing yet.</p>}</section>
}

export function ArtistLabel({ row }: { row: StatsRow }) { return row.artistId ? <Link to={`/artists/${row.artistId}`}>{row.artist}</Link> : <>{row.artist}</> }
export function AlbumLabel({ row }: { row: StatsRow }) { return <><Link to={`/albums/${row.albumId}`}>{row.album}</Link><small> · {row.artist}</small></> }
export function TrackLabel({ row }: { row: StatsRow }) { return <>{row.albumId ? <Link to={`/albums/${row.albumId}`}>{row.title}</Link> : row.title}<small> · {row.artist}</small></> }
