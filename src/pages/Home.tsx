import { useEffect, useState } from 'react'
import { ArrowRight, Clock3, Play, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AlbumCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { usePlayer } from '../stores/player'

function greetingForDate(date: Date) {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning.'
  if (hour < 18) return 'Good afternoon.'
  return 'Good evening.'
}

export function Home() {
  const api = useApi()
  const [greeting, setGreeting] = useState(() => greetingForDate(new Date()))
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
    document.addEventListener('visibilitychange', updateGreeting)
    window.addEventListener('focus', updateGreeting)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', updateGreeting)
      window.removeEventListener('focus', updateGreeting)
    }
  }, [])

  return <div className="page home-page"><header className="page-header hero"><div><span className="eyebrow"><Sparkles size={14}/> Your library</span><h1>{greeting}</h1><p>Pick up where you left off, or find something new in the collection.</p></div>{data?.recent[0] && <button className="button primary" onClick={() => void playAlbum(data.recent[0].id)}><Play fill="currentColor"/>Play something</button>}</header>{loading && <><SectionTitle title="Recently played"/><SkeletonGrid/><SectionTitle title="Fresh from the shelves"/><SkeletonGrid rows={4}/></>}{error && <ErrorState message={error} retry={retry}/>} {data && !loading && <>{data.recent.length ? <LibrarySection title="Recently played" icon={<Clock3/>} albums={data.recent} onPlay={playAlbum}/> : <EmptyState title="Nothing played yet" message="Your listening history will appear here."/>}<LibrarySection title="Fresh from the shelves" subtitle="Recently added" albums={data.newest} onPlay={playAlbum}/>{data.starred.length > 0 && <LibrarySection title="Made for you" subtitle="Your favourite albums" albums={data.starred} onPlay={playAlbum}/>}</>}</div>
}
function SectionTitle({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: React.ReactNode }) { return <div className="section-title"><div>{subtitle && <span className="eyebrow">{subtitle}</span>}<h2>{icon}{title}</h2></div><Link to="/albums">See all <ArrowRight/></Link></div> }
function LibrarySection({ title, subtitle, icon, albums, onPlay }: { title: string; subtitle?: string; icon?: React.ReactNode; albums: Parameters<typeof AlbumCard>[0]['album'][]; onPlay: (id: string) => Promise<void> }) { return <section><SectionTitle title={title} subtitle={subtitle} icon={icon}/><div className="card-grid">{albums.map((album) => <AlbumCard album={album} key={album.id} onPlay={() => void onPlay(album.id)}/>)}</div></section> }
