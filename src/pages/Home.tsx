import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Clock3, Gift, Play, RefreshCw, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AlbumCard } from '../components/MediaCards'
import { MixCard } from '../components/MixCard'
import { DjButton, DjPanel } from '../components/DjPanel'
import { ListeningNow } from '../components/ListeningNow'
import { NewReleases } from '../components/NewReleases'
import { OnThisDay } from '../components/OnThisDay'
import { ForgottenFavourites } from '../components/ForgottenFavourites'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { usePlayer } from '../stores/player'
import { useAuth } from '../stores/auth'
import { cachedMixes, mixesApi, type MixesResponse } from '../lib/mixes-api'
import { wrappedSeasonYear } from '../lib/listening-stats'

const homeMessages = [
  "You look nice today.",
  "Excellent choice opening Tomify.",
  "Your music misses you.",
  "Time for something lovely.",
  "Go on, put your favourite one on.",
  "This feels like a music sort of day.",
  "You deserve a good soundtrack.",
  "Welcome back, gorgeous.",
  "A little music makes everything better.",
  "Find something that makes you smile.",
  "The records were wondering where you'd got to.",
  "Today has excellent playlist potential.",
  "Pick something you know every word to.",
  "Your next favourite song might be in here.",
  "Everything's better with a soundtrack.",
  "You have impeccable taste, obviously.",
  "Put something on and make the room nicer.",
  "Music first. Everything else can wait a minute.",
  "Here's your little corner of good music.",
  "Pick a song. Improve the day.",
  "You bring the vibes, Tomify brings the tunes.",
  "A good song would suit you right now.",
  "Play something that feels like home.",
  "Your ears deserve a treat.",
  "Just a reminder: you're pretty great.",
  "There's always time for one more song.",
  "Find something worth turning up.",
  "Your soundtrack is ready when you are.",
  "Tiny bit of music therapy?",
  "Today's forecast: 100% chance of bangers.",
  "Life's too short for bad playlists.",
  "Go on. Play the one you're already thinking about.",
  "This is your sign to put something good on.",
  "The day could use a little more music.",
  "Something cosy, something loud, or both?",
  "Your excellent taste has been noted.",
  "Come for the music, stay because you're lovely.",
  "A soundtrack for whatever today turns into.",
  "Press play. That's probably the right answer.",
  "No algorithms. No ads. Just your lovely little music collection."
]

function greetingForDate(date: Date) {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning.'
  if (hour < 18) return 'Good afternoon.'
  return 'Good evening.'
}

export function Home() {
  const api = useApi()
  const username = useAuth((state) => state.session?.username)
  const [greeting, setGreeting] = useState(() => greetingForDate(new Date()))
  const [homeMessage] = useState(() => homeMessages[Math.floor(Math.random() * homeMessages.length)])
  const { data, error, loading, retry } = useLoad(async (signal) => {
    const [recent, newest, starred] = await Promise.all([
      api.albums('recent', 8, signal),
      api.albums('newest', 8, signal),
      api.albums('starred', 8, signal),
    ])
    return { recent, newest, starred }
  }, [api])
  const playAlbum = async (id: string) => usePlayer.getState().playTracks((await api.album(id)).song ?? [])

  useEffect(() => {
    const updateGreeting = () => setGreeting(greetingForDate(new Date()))
    const interval = window.setInterval(updateGreeting, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  return <div className="page home-page"><header className="page-header hero"><div><span className="eyebrow"><Sparkles size={14}/> Your library</span><h1>{greeting.replace('.', '')}{username ? `, ${username}` : ''}.</h1><p>{homeMessage}</p></div><div className="hero-actions"><DjButton/>{data?.recent[0] && <button className="button primary" onClick={() => void playAlbum(data.recent[0].id)}><Play fill="currentColor"/>Play something</button>}</div></header><DjPanel/><ListeningNow/><WrappedBanner/>{loading && <><SectionTitle title="Recently played"/><SkeletonGrid/><SectionTitle title="Fresh from the shelves"/><SkeletonGrid rows={4}/></>}{error && <ErrorState message={error} retry={retry}/>} {data && !loading && <>{data.recent.length ? <LibrarySection title="Recently played" icon={<Clock3/>} albums={data.recent} onPlay={playAlbum}/> : <EmptyState title="Nothing played yet" message="Your listening history will appear here."/>}<LibrarySection title="Fresh from the shelves" subtitle="Recently added" albums={data.newest} onPlay={playAlbum}/><MadeForYou/><OnThisDay/><ForgottenFavourites/><NewReleases/>{data.starred.length > 0 && <LibrarySection title="Favourite albums" subtitle="Starred" albums={data.starred} onPlay={playAlbum}/>}</>}</div>
}
// Each "See all" opens the full list behind its section rather than the A–Z albums page.
const seeAll: Record<string, string> = { 'Recently played': '/albums?type=all&sort=played', 'Fresh from the shelves': '/albums?type=all&sort=added', 'Favourite albums': '/favourites' }
function SectionTitle({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: React.ReactNode }) { return <div className="section-title"><div>{subtitle && <span className="eyebrow">{subtitle}</span>}<h2>{icon}{title}</h2></div><Link to={seeAll[title] ?? '/albums'} aria-label={`See all ${title.toLowerCase()}`}>See all <ArrowRight/></Link></div> }
function LibrarySection({ title, subtitle, icon, albums, onPlay }: { title: string; subtitle?: string; icon?: React.ReactNode; albums: Parameters<typeof AlbumCard>[0]['album'][]; onPlay: (id: string) => Promise<void> }) { return <section><SectionTitle title={title} subtitle={subtitle} icon={icon}/><div className="card-grid">{albums.map((album) => <AlbumCard album={album} key={album.id} onPlay={() => void onPlay(album.id)}/>)}</div></section> }

// Home loads the stored mixes straight away and, if they are a day old, asks the Worker to build new ones.
export function MadeForYou() {
  const [state, setState] = useState<MixesResponse | null>(() => cachedMixes())
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshMixes = useRef(() => {})

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const update = (value: MixesResponse) => { if (!cancelled) setState(value) }
    const build = async (force: boolean) => {
      setBuilding(true); setError(null)
      try { update(await mixesApi.refresh(force)) } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Tomify could not build your mixes.') } finally { if (!cancelled) setBuilding(false) }
    }
    // Another tab or device is already building them: check back until it finishes.
    const waitForOther = (attempt = 0) => { timer = window.setTimeout(async () => { try { const value = await mixesApi.load(); update(value); if (value.refreshing && attempt < 18) waitForOther(attempt + 1) } catch { /* try again on the next visit */ } }, 10_000) }
    mixesApi.load().then((value) => {
      update(value)
      if (value.refreshing) waitForOther()
      else if (value.stale) void build(false)
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Tomify could not load your mixes.') })
    refreshMixes.current = () => void build(true)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [])

  const mixes = state?.mixes ?? []
  const play = (index: number) => usePlayer.getState().playTracks(mixes[index].tracks)
  const status = building ? (mixes.length ? 'Refreshing your mixes…' : 'Building your mixes from what you listen to. This can take a minute.') : error ?? (state?.lastError && !mixes.length ? state.lastError : null)
  if (!mixes.length && !building && !error && !state?.refreshing) return null
  return <section aria-label="Made for you"><div className="section-title"><div><span className="eyebrow">{state?.curatedBy === 'claude' ? 'Picked by Claude' : 'From your listening'}</span><h2><Sparkles/>Made for you</h2></div>{mixes.length > 0 && <button className="link-button" onClick={() => refreshMixes.current()} disabled={building}><RefreshCw className={building ? 'spin' : ''}/>Refresh</button>}</div>{status && <p className="mixes-status" role="status">{status}</p>}{mixes.length ? <div className="card-grid">{mixes.map((mix, index) => <MixCard key={mix.id} mix={mix} onPlay={() => play(index)}/>)}</div> : (building || state?.refreshing) && <SkeletonGrid rows={6}/>}</section>
}

// Through December and January, Home links to the year's Wrapped recap.
function WrappedBanner() {
  const year = wrappedSeasonYear()
  if (!year) return null
  return <Link className="wrapped-banner" to={`/wrapped/${year}`}><Gift/><span><strong>Your {year} Wrapped</strong><small>Your year in music: top artists, songs, genres and more.</small></span><ArrowRight/></Link>
}
