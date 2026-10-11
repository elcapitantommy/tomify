import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Album, ArrowLeft, CircleUserRound, Download, Heart, Home, ListMusic, Search, Settings, UsersRound } from 'lucide-react'
import { PlayerBar } from './Player'
import { PlayerRuntime } from './PlayerRuntime'

const primary = [{ to: '/', label: 'Home', icon: Home }, { to: '/search', label: 'Search', icon: Search }, { to: '/artists', label: 'Artists', icon: UsersRound }, { to: '/albums', label: 'Albums', icon: Album }]
const library = [{ to: '/playlists', label: 'Playlists', icon: ListMusic }, { to: '/favourites', label: 'Favourites', icon: Heart }, { to: '/downloads', label: 'Downloads', icon: Download }]
const mobile = [{ to: '/', label: 'Home', icon: Home }, { to: '/search', label: 'Search', icon: Search }, { to: '/artists', label: 'Artists', icon: UsersRound }, { to: '/albums', label: 'Albums', icon: Album }, { to: '/favourites', label: 'Favourites', icon: Heart }]

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const canGoBack = location.pathname !== '/'
  const [topbarHidden, setTopbarHidden] = useState(false)
  const lastScrollY = useRef(0)

  useEffect(() => {
    lastScrollY.current = window.scrollY
    setTopbarHidden(false)
    const onScroll = () => {
      const y = window.scrollY
      const delta = y - lastScrollY.current
      if (y < 40) setTopbarHidden(false)
      else if (delta > 8) setTopbarHidden(true)
      else if (delta < -8) setTopbarHidden(false)
      lastScrollY.current = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [location.pathname])
  const goBack = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  return <div className="app-shell">
    <aside className="sidebar"><NavLink className="logo" to="/"><img className="brand-logo small" src="/tomify-logo-192.png" alt=""/><strong>Tomify</strong></NavLink><nav>{primary.map((item) => <NavItem {...item} key={item.to}/>)}</nav><div className="nav-section"><span>Your library</span>{library.map((item) => <NavItem {...item} key={item.to}/>)}</div><NavLink className="settings-link" to="/settings"><Settings/>Settings</NavLink><div className="sidebar-user"><CircleUserRound/><span><strong>Listening as</strong><small>Your Navidrome account</small></span></div></aside>
    <div className={topbarHidden ? "mobile-topbar hidden" : "mobile-topbar"}>{canGoBack ? <button type="button" className="mobile-back" onClick={goBack} aria-label="Go back"><ArrowLeft/></button> : <img className="brand-logo mobile-topbar-logo" src="/tomify-logo-192.png" alt=""/>}<strong>Tomify</strong></div>
    <main className="content" key={location.pathname}><Outlet/></main>
    <nav className="mobile-nav">{mobile.map((item) => <NavItem {...item} key={item.to}/>)}</nav>
    <PlayerRuntime/><PlayerBar/>
  </div>
}
function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Home }) { return <NavLink to={to} end={to === '/'}><Icon/><span>{label}</span></NavLink> }
