import { useCallback, useEffect, useState } from 'react'
import { Radio } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Artwork } from './Artwork'
import { ItemArtists } from './ArtistLinks'
import { useApi } from '../lib/api-context'
import { sameAccount, type NowPlaying } from '../lib/navidrome'
import { usePoll } from '../lib/usePoll'
import { usePlayer } from '../stores/player'

// Navidrome keeps a minute-by-minute "now playing" list for every account. Entries this old have stopped.
const STALE_MINUTES = 10

// What other people on this music server are playing right now ("Anna is playing…").
export function ListeningNow() {
  const api = useApi()
  const [entries, setEntries] = useState<NowPlaying[]>([])
  const refresh = useCallback(async (signal: AbortSignal) => {
    const all = await api.nowPlaying(signal)
    const latest = new Map<string, NowPlaying>()
    for (const entry of all) {
      const key = entry.username.toLowerCase()
      const seen = latest.get(key)
      if (!sameAccount(entry.username, api.session.username) && entry.minutesAgo <= STALE_MINUTES && (!seen || entry.minutesAgo < seen.minutesAgo)) latest.set(key, entry)
    }
    if (!signal.aborted) setEntries([...latest.values()])
  }, [api])
  useEffect(() => { const controller = new AbortController(); refresh(controller.signal).catch(() => undefined); return () => controller.abort() }, [refresh])
  usePoll(true, refresh, 30_000)
  if (!entries.length) return null
  return <section aria-label="Listening now"><div className="section-title"><div><span className="eyebrow">On this server</span><h2><Radio/>Listening now</h2></div></div>
    <div className="listening-now">{entries.map((entry) => <div className="listening-now-entry" key={entry.username}>
      <Artwork id={entry.coverArt} albumId={entry.albumId} alt="" size={120}/>
      <span><small><strong>{entry.username}</strong> is playing{entry.minutesAgo > 1 ? ` (${entry.minutesAgo} min ago)` : ''}</small><strong>{entry.title}</strong><small><ItemArtists item={entry}/>{entry.albumId ? <> · <Link to={`/albums/${entry.albumId}`}>{entry.album}</Link></> : ''}</small></span>
      <button className="button secondary" onClick={() => usePlayer.getState().playNow(entry)} aria-label={`Play ${entry.title}`}>Play</button>
    </div>)}</div>
  </section>
}
