import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, Music2, PartyPopper, Plus, Search, ThumbsUp, X } from 'lucide-react'
import { PartyError, partyGuestApi, type GuestParty } from '../lib/party'
import type { Track } from '../types'

// The page guests open on their phones (/join/<code>). It needs no Tomify login: joining gives the phone a guest
// token, kept in localStorage so a reload stays in the party.
const STORAGE_KEY = 'tomify-party-guest'
const POLL_MS = 5000
interface Saved { token: string; code: string; name: string }
const readSaved = (): Saved | null => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null } }
const writeSaved = (value: Saved | null) => { try { if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORAGE_KEY) } catch { /* private mode */ } }
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Something went wrong.'

export function PartyGuest({ initialCode = '' }: { initialCode?: string }) {
  const [saved, setSaved] = useState<Saved | null>(() => { const value = readSaved(); return value && (!initialCode || value.code === initialCode.toUpperCase()) ? value : null })
  const leave = useCallback(() => { writeSaved(null); setSaved(null) }, [])
  return <main className="party-guest">
    <header><img className="brand-logo small" src="/tomify-logo-192.png" alt=""/><strong>Tomify</strong>{saved && <button type="button" className="button secondary" onClick={leave}>Leave</button>}</header>
    {saved ? <GuestParty saved={saved} onEnded={leave}/> : <JoinForm initialCode={initialCode} onJoined={(value) => { writeSaved(value); setSaved(value) }}/>}
  </main>
}

function JoinForm({ initialCode, onJoined }: { initialCode: string; onJoined(value: Saved): void }) {
  const [code, setCode] = useState(initialCode.toUpperCase())
  const [name, setName] = useState(() => readSaved()?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function join(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try { const result = await partyGuestApi.join(code, name); onJoined({ token: result.token, code: code.trim().toUpperCase(), name: name.trim() }) } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  return <form className="party-join" onSubmit={(event) => void join(event)}>
    <PartyPopper size={36}/><h1>Join the party</h1><p>Enter the code from the host's screen, then add songs to the queue.</p>
    <label><span>Party code</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" required maxLength={12} className="party-code-input"/></label>
    <label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} autoComplete="given-name"/></label>
    {error && <div className="login-error" role="alert">{error}</div>}
    <button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin"/> : null}Join</button>
  </form>
}

function Cover({ token, track }: { token: string; track: Track }) {
  const url = partyGuestApi.coverUrl(token, track.coverArt)
  return url ? <img className="party-cover" src={url} alt="" loading="lazy"/> : <span className="party-cover"><Music2/></span>
}

function GuestParty({ saved, onEnded }: { saved: Saved; onEnded(): void }) {
  const { token } = saved
  const [party, setParty] = useState<GuestParty | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Track[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const ended = useRef(onEnded)
  ended.current = onEnded
  const run = useCallback(async (action: () => Promise<GuestParty>) => {
    try { setParty(await action()); setError(null); return true } catch (reason) {
      if (reason instanceof PartyError && reason.code === 'party-ended') ended.current()
      else setNotice(message(reason))
      return false
    }
  }, [])
  useEffect(() => {
    let stopped = false
    const load = () => partyGuestApi.load(token).then((value) => { if (!stopped) { setParty(value); setError(null) } }, (reason) => { if (stopped) return; if (reason instanceof PartyError && reason.code === 'party-ended') ended.current(); else setError(message(reason)) })
    void load()
    const timer = window.setInterval(() => { void load(); setNow(Date.now()) }, POLL_MS)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { stopped = true; window.clearInterval(timer); window.clearInterval(clock) }
  }, [token])
  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) { setResults(null); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearching(true)
      partyGuestApi.search(token, text, controller.signal).then((value) => setResults(value.tracks), (reason) => { if (!controller.signal.aborted) setNotice(message(reason)) }).finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query, token])

  if (!party) return error ? <div className="party-join"><p className="login-error" role="alert">{error}</p></div> : <div className="party-join"><LoaderCircle className="spin"/></div>
  const wait = Math.ceil((party.me.nextAddAt - now) / 1000)
  const waiting = party.queue.filter((item) => item.mine && item.state === 'pending').length
  const full = waiting >= party.party.maxPerGuest
  const queuedIds = new Set(party.queue.map((item) => item.track.id))
  const add = (track: Track) => { setNotice(null); void run(() => partyGuestApi.add(token, track.id)).then((added) => { if (added) { setQuery(''); setNow(Date.now()) } }) }

  return <div className="party-room">
    <h1>{party.party.name}</h1><p className="party-me">You're in as {party.me.name}</p>
    {party.nowPlaying && <section className="party-now"><Cover token={token} track={party.nowPlaying}/><span><small>Now playing</small><strong>{party.nowPlaying.title}</strong><small>{party.nowPlaying.artist}</small></span></section>}
    <section className="party-search">
      <label className="input-wrap"><Search/><input type="text" enterKeyHint="search" placeholder="Search for a song or artist" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search the library" title="Search the library"/>{query && <button type="button" className="icon-button" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><X/></button>}</label>
      <p className="party-limit" role="status">{wait > 0 ? `You can add another song in ${wait}s.` : full ? `You have ${waiting} waiting. Add more once one has played.` : `You can have ${party.party.maxPerGuest} waiting at a time.`}</p>
      {notice && <p className="login-error" role="alert">{notice}</p>}
      {searching && <LoaderCircle className="spin"/>}
      {results && <ol className="party-list">{results.length ? results.map((track) => <li key={track.id}><Cover token={token} track={track}/><span><strong>{track.title}</strong><small>{track.artist} · {track.album}</small></span>
        <button type="button" className="button primary" disabled={wait > 0 || full || queuedIds.has(track.id)} onClick={() => add(track)}>{queuedIds.has(track.id) ? 'Queued' : <><Plus/>Add</>}</button></li>) : <li className="health-empty">No songs match.</li>}</ol>}
    </section>
    <section><h2>Up next</h2>{party.queue.length ? <ol className="party-list">{party.queue.map((item) => <li key={item.id}><Cover token={token} track={item.track}/><span><strong>{item.track.title}</strong><small>{item.track.artist} · {item.mine ? 'you' : item.guestName}{item.state === 'queued' ? ' · next' : ''}</small></span>
      {party.party.voting && item.state === 'pending' && !item.mine && <button type="button" className={item.voted ? 'button primary party-vote' : 'button secondary party-vote'} aria-pressed={item.voted} aria-label={`Vote for ${item.track.title}`} onClick={() => void run(() => partyGuestApi.vote(token, item.id))}><ThumbsUp/>{item.votes}</button>}
      {party.party.voting && (item.state !== 'pending' || item.mine) && <small className="party-votes"><ThumbsUp size={14}/>{item.votes}</small>}
      {item.mine && item.state === 'pending' && <button type="button" className="icon-button" aria-label={`Remove ${item.track.title}`} title={`Remove ${item.track.title}`} onClick={() => void run(() => partyGuestApi.remove(token, item.id))}><X/></button>}
    </li>)}</ol> : <p className="health-empty">The queue is empty. Search above to add the first song.</p>}</section>
  </div>
}
