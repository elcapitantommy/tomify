import { useCallback, useEffect, useState } from 'react'
import { History as HistoryIcon, LoaderCircle, Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Artwork } from '../components/Artwork'
import { ArtistLinks } from '../components/ArtistLinks'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { groupByDay, loadHistory, playTime, replayFrom, type HistoryEvent } from '../lib/listening-history'
import { usePlayer } from '../stores/player'

const HIDE_SKIPPED_KEY = 'tomify-history-hide-skipped'
const hideSkippedSaved = () => { try { return window.localStorage.getItem(HIDE_SKIPPED_KEY) === '1' } catch { return false } }

// Every song played on any device, newest first and grouped by day. Tapping one plays it and what came after it.
export function History() {
  const [events, setEvents] = useState<HistoryEvent[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hideSkipped, setHideSkipped] = useState(hideSkippedSaved)

  const load = useCallback(async (before: string | null) => {
    setLoading(true); setError(null)
    try {
      const page = await loadHistory(before)
      setEvents((current) => before ? [...current, ...page.events] : page.events)
      setNext(page.next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Listening history is unavailable.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(null) }, [load])

  const toggleSkipped = () => {
    setHideSkipped(!hideSkipped)
    try { window.localStorage.setItem(HIDE_SKIPPED_KEY, hideSkipped ? '0' : '1') } catch { /* storage unavailable */ }
  }
  const days = groupByDay(events, new Date(), hideSkipped)

  return <div className="page narrow-page history-page"><header className="page-header"><span className="eyebrow"><HistoryIcon size={14}/> Your library</span><h1>Listening history</h1><p>Every song you've played on any device, newest first. Play one to carry on from there.</p></header>
    <div className="history-tools"><label><input type="checkbox" checked={hideSkipped} onChange={toggleSkipped}/> Hide skipped songs</label><Link to="/stats">Listening stats</Link></div>
    {error && <ErrorState message={error} retry={() => void load(events.length ? next : null)}/>}
    {loading && !events.length && <SkeletonGrid rows={2}/>}
    {!loading && !error && !events.length && <EmptyState title="Nothing played yet" message="Songs you play will be listed here."/>}
    {days.map((day) => <section key={day.label} className="history-day"><h2>{day.label}</h2><ol>{day.plays.map(({ event, index }) => <li key={event.id} className={event.skipped ? 'skipped' : undefined}>
      <span className="history-time">{playTime(event.playedAt)}</span>
      <button type="button" className="history-play" onClick={() => usePlayer.getState().playTracks(replayFrom(events, index), 0, { keepOrder: true })} aria-label={`Play ${event.title ?? 'this song'} and what came after it`} title="Play from here"><Artwork id={event.albumId ?? undefined} albumId={event.albumId ?? undefined} alt="" size={96}/><Play fill="currentColor"/></button>
      <span className="history-copy"><strong>{event.title ?? 'Unknown song'}</strong><small><ArtistLinks name={event.artist} artistId={event.artistId}/>{event.album && <>{' · '}{event.albumId ? <Link to={`/albums/${event.albumId}`}>{event.album}</Link> : event.album}</>}</small></span>
      <span className="history-tags">{event.skipped && <i>Skipped</i>}{event.device && <small>{event.device}</small>}</span>
    </li>)}</ol></section>)}
    {next && <div className="history-more"><button type="button" className="button secondary" disabled={loading} onClick={() => void load(next)}>{loading ? <LoaderCircle className="spin"/> : null}Show older plays</button></div>}
  </div>
}
