import { Database, LogOut, Server, ShieldCheck } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { useReleaseMetadata } from '../stores/releaseMetadata'

export function Settings() {
  const session = useAuth((s) => s.session)
  const logout = useAuth((s) => s.logout)
  const cloudStatus = useReleaseMetadata((s) => s.cloudStatus)
  const loadMetadata = useReleaseMetadata((s) => s.load)
  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>Your account and playback setup.</p></header><section className="settings-card"><h2>Music server</h2><div className="setting-row"><Server/><span><strong>{session?.serverUrl}</strong><small>Signed in as {session?.username}</small></span><i className="connected">Connected</i></div><div className="setting-row"><ShieldCheck/><span><strong>Navidrome authentication</strong><small>Tomify stores a revocable token, never your password.</small></span></div></section><section className="settings-card"><h2>Release metadata</h2><div className="setting-row"><Database/><span><strong>{cloudStatus === 'cloud' ? 'Cloud metadata connected' : cloudStatus === 'checking' ? 'Checking metadata store…' : 'Browser-only metadata'}</strong><small>{cloudStatus === 'cloud' ? 'Album types and release-date overrides sync across Tomify devices.' : 'Your release flags still work, but currently stay on this browser.'}</small></span><button className="button secondary" onClick={() => void loadMetadata()}>Check sync</button></div></section><section className="settings-card"><h2>Session</h2><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section></div>
}
