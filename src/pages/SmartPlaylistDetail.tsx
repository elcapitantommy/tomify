import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Play, Radio, RadioTower, RefreshCw, Save, Shuffle, Sparkles, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DjPanel } from '../components/DjPanel'
import { ErrorState } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { DEFAULT_LIMIT, describeRules, evaluateSmartPlaylist, loadLibrary, MAX_LIMIT, smartPlaylistsApi, smartPool, type PlayedRule, type SmartRules, type SmartSort } from '../lib/smart-playlists'
import { useDj } from '../stores/dj'
import { usePlayer } from '../stores/player'
import { useRadio } from '../stores/radio'
import type { Track } from '../types'

const sorts: [SmartSort, string][] = [['random', 'Random'], ['most-played', 'Most played'], ['least-played', 'Least played'], ['recently-added', 'Recently added'], ['recently-played', 'Recently played'], ['newest', 'Newest releases'], ['oldest', 'Oldest releases']]
const playedRules: [PlayedRule, string][] = [['any', 'Any time'], ['never', 'Never played'], ['within', 'Played in the last…'], ['not-within', 'Not played in…']]
const number = (value: string) => { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined }
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

export function SmartPlaylistDetail() {
  const api = useApi(); const navigate = useNavigate(); const { id = 'new' } = useParams(); const isNew = id === 'new'
  const [name, setName] = useState('')
  const [rules, setRules] = useState<SmartRules>({ sort: 'random', limit: DEFAULT_LIMIT })
  const [loading, setLoading] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)
  const [library, setLibrary] = useState<Track[] | null>(null)
  const [loaded, setLoaded] = useState(0)
  const [genres, setGenres] = useState<string[]>([])
  const [seed, setSeed] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (isNew) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    smartPlaylistsApi.get(id).then((playlist) => { if (!cancelled) { setName(playlist.name); setRules(playlist.rules) } }).catch((reason) => { if (!cancelled) setError(message(reason, 'The smart playlist could not be loaded.')) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, isNew])
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLibraryError(null)
    loadLibrary(api, (count) => { if (!cancelled) setLoaded(count) }, reload > 0).then((songs) => { if (!cancelled) setLibrary(songs) }).catch((reason) => { if (!cancelled) setLibraryError(message(reason, 'The library could not be read.')) })
    api.genres().then((values) => { if (!cancelled) setGenres(values) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [api, reload])

  const tracks = useMemo(() => library ? evaluateSmartPlaylist(library, rules, Date.now(), seed) : [], [library, rules, seed])
  // Every matching song, ignoring the order and length: what the DJ and song radio pick from.
  const pool = useMemo(() => library ? smartPool(library, rules) : [], [library, rules])
  // Moods are whatever the library's MOOD tags hold, so only ones that exist are offered.
  const moods = useMemo(() => [...new Set([...(library ?? []).flatMap((track) => track.moods ?? []), ...(rules.moods ?? [])])].sort((a, b) => a.localeCompare(b)), [library, rules.moods])
  const poolName = name.trim() || 'Smart playlist'
  const startRadio = () => { if (pool.length) void useRadio.getState().start(pool[Math.floor(Math.random() * pool.length)], { name: poolName, rules }) }
  const startDj = () => { if (pool.length) void useDj.getState().start(null, { name: poolName, tracks: pool }) }
  const set = (patch: Partial<SmartRules>) => setRules((current) => ({ ...current, ...patch }))

  async function save() {
    if (!name.trim()) { setNotice('Give the smart playlist a name.'); return }
    setBusy('save'); setNotice(null)
    try {
      if (isNew) { const created = await smartPlaylistsApi.create(name.trim(), rules); navigate(`/playlists/smart/${created.id}`, { replace: true }) }
      else { await smartPlaylistsApi.update(id, name.trim(), rules) }
      setNotice('Saved.')
    } catch (reason) { setNotice(message(reason, 'The smart playlist could not be saved.')) } finally { setBusy(null) }
  }
  async function remove() {
    setBusy('delete')
    try { await smartPlaylistsApi.remove(id); navigate('/playlists') } catch (reason) { setNotice(message(reason, 'The smart playlist could not be deleted.')); setBusy(null) }
  }
  // A snapshot as an ordinary Navidrome playlist, for other apps or for keeping a random pick.
  async function snapshot() {
    setBusy('snapshot'); setNotice(null)
    try { const playlist = await api.createPlaylist(`${name.trim() || 'Smart playlist'} (${new Date().toLocaleDateString()})`, tracks.map((track) => track.id)); navigate(`/playlists/${playlist.id}`) }
    catch (reason) { setNotice(message(reason, 'The playlist could not be created.')); setBusy(null) }
  }

  if (loading) return <div className="page"><p className="variant-loading"><LoaderCircle className="spin"/>Loading the smart playlist…</p></div>
  if (error) return <div className="page"><ErrorState message={error} retry={() => navigate(0)}/></div>
  const duration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0)
  const rule = (label: string, control: React.ReactNode) => <label className="smart-rule"><span>{label}</span>{control}</label>

  return <div className="page detail-page"><header className="detail-hero playlist-hero"><div className="playlist-cover smart"><Sparkles/></div><div><span className="eyebrow">Smart playlist</span><h1>{name.trim() || 'New smart playlist'}</h1><p>{describeRules(rules)}{library ? ` · ${tracks.length} songs · ${formatHours(duration)}` : ''}</p>
    <div className="hero-actions"><button className="button primary" disabled={!tracks.length} onClick={() => usePlayer.getState().playTracks(tracks, 0, { keepOrder: true })}><Play fill="currentColor"/>Play</button>
      {(rules.sort ?? 'random') === 'random' && <button className="button secondary" disabled={!library} onClick={() => setSeed(Date.now())}><Shuffle/>New pick</button>}
      <button className="button secondary" disabled={!pool.length} onClick={startRadio} title="Endless radio from these songs"><RadioTower/>Start radio</button>
      <button className="button secondary" disabled={!pool.length} onClick={startDj} title="The DJ picks from these songs"><Radio/>Start DJ</button>
      <button className="button secondary" disabled={!tracks.length || busy !== null} onClick={() => void snapshot()}>{busy === 'snapshot' ? <LoaderCircle className="spin"/> : <Save/>}Save as playlist</button></div></div></header>
    <DjPanel/>

    <section className="smart-editor" aria-label="Rules">
      {rule('Name', <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Late-night jazz"/>)}
      {rule('Genres', <select multiple value={rules.genres ?? []} onChange={(event) => set({ genres: [...event.target.selectedOptions].map((option) => option.value) })} size={Math.min(6, Math.max(3, genres.length))}>{[...new Set([...genres, ...(rules.genres ?? [])])].map((genre) => <option key={genre} value={genre}>{genre}</option>)}</select>)}
      {rule('Moods', moods.length ? <select multiple value={rules.moods ?? []} onChange={(event) => set({ moods: [...event.target.selectedOptions].map((option) => option.value) })} size={Math.min(6, Math.max(3, moods.length))}>{moods.map((mood) => <option key={mood} value={mood}>{mood}</option>)}</select> : <small>{library ? 'No songs have a mood tag yet.' : 'Reading moods from your library…'}</small>)}
      <div className="smart-rule-pair">{rule('From bpm', <input inputMode="numeric" value={rules.bpmFrom ?? ''} placeholder="e.g. 120" onChange={(event) => set({ bpmFrom: number(event.target.value) })}/>)}{rule('To bpm', <input inputMode="numeric" value={rules.bpmTo ?? ''} placeholder="e.g. 130" onChange={(event) => set({ bpmTo: number(event.target.value) })}/>)}</div>
      {rule('Artist contains', <input value={rules.artist ?? ''} onChange={(event) => set({ artist: event.target.value || undefined })}/>)}
      <div className="smart-rule-pair">{rule('From year', <input inputMode="numeric" value={rules.yearFrom ?? ''} onChange={(event) => set({ yearFrom: number(event.target.value) })}/>)}{rule('To year', <input inputMode="numeric" value={rules.yearTo ?? ''} onChange={(event) => set({ yearTo: number(event.target.value) })}/>)}</div>
      {rule('Last played', <span className="smart-rule-inline"><select value={rules.played ?? 'any'} onChange={(event) => set({ played: event.target.value as PlayedRule })}>{playedRules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{(rules.played === 'within' || rules.played === 'not-within') && <><input aria-label="Days" inputMode="numeric" value={rules.playedDays ?? 30} onChange={(event) => set({ playedDays: number(event.target.value) })}/>days</>}</span>)}
      <div className="smart-rule-pair">{rule('Played at least', <input inputMode="numeric" value={rules.minPlays ?? ''} placeholder="times" onChange={(event) => set({ minPlays: number(event.target.value) })}/>)}{rule('Added in the last', <input inputMode="numeric" value={rules.addedDays ?? ''} placeholder="days" onChange={(event) => set({ addedDays: number(event.target.value) })}/>)}</div>
      {rule('Added since', <span className="smart-rule-inline"><input type="date" value={rules.addedFrom ?? ''} onChange={(event) => set({ addedFrom: event.target.value || undefined })}/><button type="button" className="link-button" onClick={() => set({ addedFrom: `${new Date().getFullYear()}-01-01` })}>This year</button></span>)}
      <div className="smart-rule-pair">{rule('Rating at least', <select value={rules.minRating ?? 0} onChange={(event) => set({ minRating: Number(event.target.value) || undefined })}>{[0, 1, 2, 3, 4, 5].map((stars) => <option key={stars} value={stars}>{stars ? `${stars} ★` : 'Any'}</option>)}</select>)}<label className="smart-rule smart-check"><input type="checkbox" checked={rules.favouritesOnly === true} onChange={(event) => set({ favouritesOnly: event.target.checked || undefined })}/>Favourites only</label></div>
      <div className="smart-rule-pair">{rule('Order', <select value={rules.sort ?? 'random'} onChange={(event) => set({ sort: event.target.value as SmartSort })}>{sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>)}{rule('Up to', <input inputMode="numeric" value={rules.limit ?? DEFAULT_LIMIT} onChange={(event) => set({ limit: Math.min(MAX_LIMIT, number(event.target.value) ?? DEFAULT_LIMIT) })}/>)}</div>
      <div className="smart-actions"><button className="button primary" disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin"/> : <Save/>}{isNew ? 'Create' : 'Save rules'}</button>{!isNew && <button className="button secondary" disabled={busy !== null} onClick={() => void remove()}><Trash2/>Delete</button>}<Link className="link-button" to="/playlists">Back to playlists</Link>{notice && <span role="status">{notice}</span>}</div>
    </section>

    {libraryError ? <ErrorState message={libraryError} retry={() => setReload((value) => value + 1)}/>
      : !library ? <p className="variant-loading"><LoaderCircle className="spin"/>Reading your library… {loaded ? `${loaded} songs` : ''}</p>
      : <section><div className="section-title"><h2>{tracks.length ? 'Matching songs' : 'No songs match these rules'}</h2><button className="button secondary" onClick={() => setReload((value) => value + 1)} aria-label="Read the library again"><RefreshCw/></button></div>{tracks.length > 0 && <TrackList tracks={tracks}/>}</section>}
  </div>
}
