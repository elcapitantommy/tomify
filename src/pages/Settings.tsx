import { Database, LockKeyhole, LogOut, Server, ShieldCheck } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { ArtworkUpgrade } from '../components/ArtworkUpgrade'
import { ServerRestart } from '../components/ServerRestart'
import { VpnControl } from '../components/VpnControl'
import { LibraryScan } from '../components/LibraryScan'
import { QualitySettings } from '../components/QualitySettings'

export function Settings() {
  const session = useAuth((s) => s.session)
  const logout = useAuth((s) => s.logout)
  const cloudStatus = useReleaseMetadata((s) => s.cloudStatus)
  const loadMetadata = useReleaseMetadata((s) => s.load)
  const isAdmin = useAuth((s) => s.isAdmin)

  // Hidden from the navigation for everyone else; this keeps a typed /settings from showing admin controls, and keeps sign out reachable.
  if (isAdmin !== true) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>{isAdmin === null ? 'Checking your account…' : 'Settings are only available to Navidrome administrators.'}</p></header>{isAdmin === false && <section className="settings-card"><div className="setting-row"><LockKeyhole/><span><strong>Signed in as {session?.username}</strong><small>Ask an administrator if you need something changed.</small></span></div><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section>}</div>

  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>Your account and playback setup.</p></header><section className="settings-card"><h2>Music server</h2><div className="setting-row"><Server/><span><strong>{session?.serverUrl}</strong><small>Signed in as {session?.username}</small></span><i className="connected">Connected</i></div><div className="setting-row"><ShieldCheck/><span><strong>Navidrome authentication</strong><small>Tomify stores a revocable token, never your password.</small></span></div><LibraryScan/><VpnControl/><ServerRestart/></section><section className="settings-card"><h2>Tomify metadata</h2><div className="setting-row"><Database/><span><strong>{cloudStatus === 'cloud' ? 'Cloud metadata connected' : cloudStatus === 'checking' ? 'Checking metadata store…' : 'Metadata store unavailable'}</strong><small>{cloudStatus === 'cloud' ? 'Release type and date overrides are stored centrally and shared across devices.' : 'Tomify is not saving release overrides locally.'}</small></span>{cloudStatus !== 'cloud' && <button className="button secondary" onClick={() => void loadMetadata()}>Retry</button>}</div><ArtworkUpgrade/></section><QualitySettings/><section className="settings-card"><h2>Session</h2><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section></div>
}
