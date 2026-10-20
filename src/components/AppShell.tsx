import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Album, ArrowLeft, CircleUserRound, Download, Heart, Home, LifeBuoy, ListMusic, LogOut, Search, Settings, UsersRound, X, BarChart3, PartyPopper } from 'lucide-react'
import { PlayerBar } from './Player'
import { PlayerRuntime } from './PlayerRuntime'
import { LivePlaybackSync } from './LivePlaybackSync'
import { DjRuntime } from './DjPanel'
import { RadioRuntime } from './SongRadio'
import { PartyRuntime } from './PartyRuntime'
import { KeyboardShortcuts } from './KeyboardShortcuts'
import { usePlayer } from '../stores/player'
import { useRemoteSession } from '../stores/livePlayback'
import { useAuth } from '../stores/auth'
import { useDownloads } from '../stores/downloads'
import { useScrollRestoration } from '../hooks/useScrollRestoration'

const primary = [{ to: '/', label: 'Home', icon: Home }, { to: '/search', label: 'Search', icon: Search }, { to: '/artists', label: 'Artists', icon: UsersRound }, { to: '/albums', label: 'Albums', icon: Album }]
const library = [{ to: '/playlists', label: 'Playlists', icon: ListMusic }, { to: '/favourites', label: 'Favourites', icon: Heart }, { to: '/stats', label: 'Listening stats', icon: BarChart3 }, { to: '/party', label: 'Party mode', icon: PartyPopper }, { to: '/downloads', label: 'Downloads', icon: Download }]
// Administrative tools stay out of the mobile tab bar and live in the account sheet instead.
const recovery = { to: '/recovery', label: 'Recovery', icon: LifeBuoy }
const mobile = [{ to: '/', label: 'Home', icon: Home }, { to: '/search', label: 'Search', icon: Search }, { to: '/artists', label: 'Artists', icon: UsersRound }, { to: '/albums', label: 'Albums', icon: Album }, { to: '/playlists', label: 'Playlists', icon: ListMusic }, { to: '/favourites', label: 'Favourites', icon: Heart }]

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const canGoBack = location.pathname !== '/'
  const [topbarHidden, setTopbarHidden] = useState(false)
  const lastScrollY = useRef(0)
  const localQueue = usePlayer((state) => state.queue)
  const localCurrentIndex = usePlayer((state) => state.currentIndex)
  const { remote } = useRemoteSession(5000)
  const localTrack = localQueue[localCurrentIndex]
  const remoteTrack = remote?.queue[remote.currentIndex]
  const titleTrack = remoteTrack ?? localTrack
  const isAdmin = useAuth((state) => state.isAdmin) === true
  const logout = useAuth((state) => state.logout)
  const username = useAuth((state) => state.session?.username)
  const session = useAuth((state) => state.session)
  const [accountOpen, setAccountOpen] = useState(false)
  // Set when Back leaves a page opened from the account sheet, so the sheet comes back instead of the page underneath.
  const reopenAccount = useRef(false)
  useScrollRestoration()

  // Offline downloads belong to the signed-in account; their queue carries on from any page.
  useEffect(() => { void useDownloads.getState().bind(session) }, [session])

  useEffect(() => {
    document.title = titleTrack
      ? `Tomify · ${titleTrack.title}${titleTrack.artist ? ` — ${titleTrack.artist}` : ''}`
      : 'Tomify'
    return () => { document.title = 'Tomify' }
  }, [titleTrack?.id, titleTrack?.title, titleTrack?.artist])

  useEffect(() => {
    setAccountOpen(reopenAccount.current)
    reopenAccount.current = false
  }, [location.pathname])

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
    // Settings and Recovery are reached from the account sheet, so Back returns to that menu rather than the page behind it.
    if ((location.state as { fromAccount?: boolean } | null)?.fromAccount) reopenAccount.current = true
    // The first page of a visit has no in-app history (key 'default'), so Back goes Home rather than leaving Tomify.
    if (location.key !== 'default') navigate(-1)
    else navigate('/')
  }

  return <div className="app-shell">
    <aside className="sidebar"><NavLink className="logo" to="/"><img className="brand-logo small" src="/tomify-logo-192.png" alt=""/><strong>Tomify</strong></NavLink><nav>{primary.map((item) => <NavItem {...item} key={item.to}/>)}</nav><div className="nav-section"><span>Your library</span>{(isAdmin ? [...library, recovery] : library).map((item) => <NavItem {...item} key={item.to}/>)}</div>{isAdmin ? <NavLink className="settings-link" to="/settings"><Settings/>Settings</NavLink> : <button type="button" className="settings-link" onClick={logout}><LogOut/>Sign out</button>}<div className="sidebar-user"><CircleUserRound/><span><small>Listening as</small><strong>{username}</strong><small>{isAdmin ? 'Navidrome administrator' : 'Your Navidrome account'}</small></span></div></aside>
    <div className={topbarHidden ? "mobile-topbar hidden" : "mobile-topbar"}>{canGoBack ? <button type="button" className="mobile-back" onClick={goBack} aria-label="Go back"><ArrowLeft/></button> : <img className="brand-logo mobile-topbar-logo" src="/tomify-logo-192.png" alt=""/>}<strong>Tomify</strong><button type="button" className="mobile-account" onClick={() => setAccountOpen(true)} aria-label="Account" aria-haspopup="dialog"><CircleUserRound/></button></div>
    {accountOpen && <AccountSheet isAdmin={isAdmin} onClose={() => setAccountOpen(false)} onLogout={logout}/>}
    <main className="content" key={location.pathname}><Outlet/></main>
    <nav className="mobile-nav">{mobile.map((item) => <NavItem {...item} key={item.to}/>)}</nav>
    <LivePlaybackSync/><PlayerRuntime/><DjRuntime/><RadioRuntime/><PartyRuntime/><PlayerBar/><KeyboardShortcuts/>
  </div>
}
function AccountSheet({ isAdmin, onClose, onLogout }: { isAdmin: boolean; onClose(): void; onLogout(): void }) {
  const username = useAuth((state) => state.session?.username)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="account-sheet-backdrop" onClick={onClose}>
    <div className="account-sheet" role="dialog" aria-modal="true" aria-label="Account" onClick={(event) => event.stopPropagation()}>
      <header><CircleUserRound/><span><strong>{username}</strong><small>{isAdmin ? 'Navidrome administrator' : 'Your Navidrome account'}</small></span><button type="button" className="account-sheet-close" onClick={onClose} aria-label="Close"><X/></button></header>
      {isAdmin && <NavLink to="/recovery" state={{ fromAccount: true }}><LifeBuoy/>Recovery</NavLink>}
      <NavLink to="/downloads" state={{ fromAccount: true }}><Download/>Downloads</NavLink>
      <NavLink to="/stats" state={{ fromAccount: true }}><BarChart3/>Listening stats</NavLink>
      <NavLink to="/party" state={{ fromAccount: true }}><PartyPopper/>Party mode</NavLink>
      <NavLink to="/settings" state={{ fromAccount: true }}><Settings/>Settings</NavLink>
      <button type="button" onClick={onLogout}><LogOut/>Sign out</button>
    </div>
  </div>
}
function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Home }) { return <NavLink to={to} end={to === '/'}><Icon/><span>{label}</span></NavLink> }
