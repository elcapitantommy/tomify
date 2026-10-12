import { useEffect, useState } from 'react'
import { ArrowRight, Clock3, Play, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AlbumCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { usePlayer } from '../stores/player'
import { useAuth } from '../stores/auth'

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
    const refreshHome = () => {
      setGreeting(greetingForDate(new Date()))
      if (!document.hidden) retry()
    }
    const interval = window.setInterval(refreshHome, 60_000)
    document.addEventListener('visibilitychange', refreshHome)
    window.addEventListener('focus', refreshHome)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshHome)
      window.removeEventListener('focus', refreshHome)
    }
  }, [retry])

  return <div className="page home-page"><header className="page-header hero"><div><span className="eyebrow"><Sparkles size={14}/> Your library</span><h1>{greeting.replace('.', '')}{username ? `, ${username}` : ''}.</h1><p>{homeMessage}</p></div>{data?.recent[0] && <button className="button primary" onClick={() => void playAlbum(data.recent[0].id)}><Play fill="currentColor"/>Play something</button>}</header>{loading && <><SectionTitle title="Recently played"/><SkeletonGrid/><SectionTitle title="Fresh from the shelves"/><SkeletonGrid rows={4}/></>}{error && <ErrorState message={error} retry={retry}/>} {data && !loading && <>{data.recent.length ? <LibrarySection title="Recently played" icon={<Clock3/>} albums={data.recent} onPlay={playAlbum}/> : <EmptyState title="Nothing played yet" message="Your listening history will appear here."/>}<LibrarySection title="Fresh from the shelves" subtitle="Recently added" albums={data.newest} onPlay={playAlbum}/>{data.starred.length > 0 && <LibrarySection title="Made for you" subtitle="Your favourite albums" albums={data.starred} onPlay={playAlbum}/>}</>}</div>
}
function SectionTitle({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: React.ReactNode }) { return <div className="section-title"><div>{subtitle && <span className="eyebrow">{subtitle}</span>}<h2>{icon}{title}</h2></div><Link to="/albums">See all <ArrowRight/></Link></div> }
function LibrarySection({ title, subtitle, icon, albums, onPlay }: { title: string; subtitle?: string; icon?: React.ReactNode; albums: Parameters<typeof AlbumCard>[0]['album'][]; onPlay: (id: string) => Promise<void> }) { return <section><SectionTitle title={title} subtitle={subtitle} icon={icon}/><div className="card-grid">{albums.map((album) => <AlbumCard album={album} key={album.id} onPlay={() => void onPlay(album.id)}/>)}</div></section> }
