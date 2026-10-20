import { useState } from 'react'
import { ExternalLink, LoaderCircle, Plus, Radio as RadioIcon, Search, Square, Play, Trash2 } from 'lucide-react'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { isSecureStream, searchDirectory, type DirectoryStation, type RadioStation } from '../lib/internet-radio'
import { useAuth } from '../stores/auth'
import { useLiveRadio } from '../stores/liveRadio'

const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

export function Radio() {
  const api = useApi()
  const isAdmin = useAuth((state) => state.isAdmin) === true
  const { data, loading, error, retry, refresh } = useLoad((signal) => api.radioStations(signal), [api], `radio:${api.session.username}`)
  const live = useLiveRadio()
  const [busy, setBusy] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const stations = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const saved = new Set(stations.map((station) => station.streamUrl))

  async function add(station: { name: string; streamUrl: string; homePageUrl?: string }, key: string) {
    setBusy(key); setEditError(null)
    try { await api.addRadioStation(station); refresh() } catch (reason) { setEditError(message(reason, 'The station could not be added.')) } finally { setBusy(null) }
  }
  async function remove(station: RadioStation) {
    setBusy(`delete-${station.id}`); setEditError(null)
    try { await api.deleteRadioStation(station.id); if (live.station?.id === station.id) live.stop(); refresh() } catch (reason) { setEditError(message(reason, 'The station could not be removed.')) } finally { setBusy(null) }
  }

  return <div className="page narrow-page radio-page">
    <header className="page-header"><span className="eyebrow"><RadioIcon size={14}/> Live</span><h1>Radio</h1><p>Internet radio stations, alongside your library. Playing a station pauses your music, and playing music stops the station.</p></header>
    {loading && <SkeletonGrid rows={3}/>}
    {error && <ErrorState message={error} retry={retry}/>}
    {data && !stations.length && <EmptyState title="No stations yet" message={isAdmin ? 'Find a station below and add it.' : 'Ask the music server administrator to add some stations.'}/>}
    {stations.length > 0 && <ul className="radio-list">{stations.map((station) => {
      const current = live.station?.streamUrl === station.streamUrl
      return <li key={station.id} className={current ? 'current' : undefined}>
        <span className="radio-icon"><RadioIcon/></span>
        <span className="radio-copy"><strong>{station.name}</strong><small>{current ? (live.status === 'error' ? live.error : live.status === 'loading' ? 'Tuning in…' : 'Playing now') : station.homePageUrl ? <a href={station.homePageUrl} target="_blank" rel="noreferrer">Website<ExternalLink size={11}/></a> : 'Live radio'}</small></span>
        {current ? <button type="button" className="button secondary" onClick={live.stop} aria-label={`Stop ${station.name}`}><Square fill="currentColor"/>Stop</button> : <button type="button" className="button primary" onClick={() => live.play(station)} aria-label={`Play ${station.name}`}><Play fill="currentColor"/>Play</button>}
        {isAdmin && <button type="button" className="icon-button" disabled={busy !== null} onClick={() => void remove(station)} aria-label={`Remove ${station.name}`} title="Remove station">{busy === `delete-${station.id}` ? <LoaderCircle className="spin"/> : <Trash2/>}</button>}
      </li>
    })}</ul>}
    {editError && <p className="device-error" role="alert">{editError}</p>}
    {isAdmin && <AddStations saved={saved} busy={busy} add={add}/>}
  </div>
}

function AddStations({ saved, busy, add }: { saved: Set<string>; busy: string | null; add(station: { name: string; streamUrl: string; homePageUrl?: string }, key: string): Promise<void> }) {
  const live = useLiveRadio()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DirectoryStation[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [link, setLink] = useState('')

  async function search(event: React.FormEvent) {
    event.preventDefault()
    if (!query.trim()) return
    setSearching(true); setSearchError(null)
    try { setResults(await searchDirectory(query.trim())) } catch (reason) { setSearchError(message(reason, 'The radio directory could not be searched.')) } finally { setSearching(false) }
  }
  const linkProblem = link.trim() && !isSecureStream(link.trim()) ? 'Use an https:// link: browsers block http radio streams on a secure page.' : null

  return <section className="settings-card radio-add" aria-label="Add stations">
    <h2>Add stations</h2>
    <p className="radio-help">Search thousands of stations from the free <a href="https://www.radio-browser.info" target="_blank" rel="noreferrer">Radio Browser</a> directory. Try them before adding; they are saved in Navidrome for every account.</p>
    <form className="radio-search" onSubmit={(event) => void search(event)}><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Station name, e.g. BBC Radio 6 Music" aria-label="Search radio stations"/><button type="submit" className="button secondary" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button></form>
    {searchError && <p className="device-error" role="alert">{searchError}</p>}
    {results && !results.length && <p className="radio-help">No stations with a secure stream match “{query}”.</p>}
    {results && results.length > 0 && <ul className="radio-list results">{results.map((station) => {
      const added = saved.has(station.streamUrl)
      const trying = live.station?.streamUrl === station.streamUrl
      return <li key={station.id}>
        <span className="radio-copy"><strong>{station.name}</strong><small>{[station.country, station.tags.join(', '), station.bitrate ? `${station.bitrate} kbps` : '', station.codec].filter(Boolean).join(' · ')}</small></span>
        <button type="button" className="icon-button" onClick={() => trying ? live.stop() : live.play({ id: `try-${station.id}`, name: station.name, streamUrl: station.streamUrl, homePageUrl: station.homePageUrl })} aria-label={trying ? `Stop ${station.name}` : `Try ${station.name}`} title={trying ? 'Stop' : 'Try it'}>{trying ? <Square fill="currentColor"/> : <Play fill="currentColor"/>}</button>
        <button type="button" className="button secondary" disabled={added || busy !== null} onClick={() => void add({ name: station.name, streamUrl: station.streamUrl, homePageUrl: station.homePageUrl }, `add-${station.id}`)} aria-label={added ? `${station.name} added` : `Add ${station.name}`}>{added ? 'Added' : busy === `add-${station.id}` ? <LoaderCircle className="spin"/> : <><Plus/>Add</>}</button>
      </li>
    })}</ul>}
    <form className="radio-link" onSubmit={(event) => { event.preventDefault(); if (name.trim() && link.trim() && !linkProblem) void add({ name: name.trim(), streamUrl: link.trim() }, 'add-link').then(() => { setName(''); setLink('') }) }}>
      <strong>Or add one by its stream link</strong>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" aria-label="Station name"/>
      <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://… stream link" aria-label="Stream link" inputMode="url"/>
      <button type="submit" className="button secondary" disabled={!name.trim() || !link.trim() || Boolean(linkProblem) || busy !== null}><Plus/>Add station</button>
      {linkProblem && <small className="device-error">{linkProblem}</small>}
    </form>
  </section>
}
