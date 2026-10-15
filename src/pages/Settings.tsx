import { Database, LogOut, Server, ShieldCheck } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { ArtworkUpgrade } from '../components/ArtworkUpgrade'

export function Settings() {
  const session = useAuth((s) => s.session)
  const logout = useAuth((s) => s.logout)
  const cloudStatus = useReleaseMetadata((s) => s.cloudStatus)
  const loadMetadata = useReleaseMetadata((s) => s.load)

  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>Your account and playback setup.</p></header><section className="settings-card"><h2>Music server</h2><div className="setting-row"><Server/><span><strong>{session?.serverUrl}</strong><small>Signed in as {session?.username}</small></span><i className="connected">Connected</i></div><div className="setting-row"><ShieldCheck/><span><strong>Navidrome authentication</strong><small>Tomify stores a revocable token, never your password.</small></span></div></section><section className="settings-card"><h2>Tomify metadata</h2><div className="setting-row"><Database/><span><strong>{cloudStatus === 'cloud' ? 'Cloud metadata connected' : cloudStatus === 'checking' ? 'Checking metadata store…' : 'Metadata store unavailable'}</strong><small>{cloudStatus === 'cloud' ? 'Release type and date overrides are stored centrally and shared across devices.' : 'Tomify is not saving release overrides locally.'}</small></span>{cloudStatus !== 'cloud' && <button className="button secondary" onClick={() => void loadMetadata()}>Retry</button>}</div><ArtworkUpgrade/></section><section className="settings-card"><h2>Session</h2><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section></div>
}
