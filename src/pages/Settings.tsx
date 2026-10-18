import { useEffect, useState } from 'react'
import { AlertTriangle, Database, GitCommitHorizontal, LockKeyhole, LogOut, Server, ShieldCheck } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { ArtworkUpgrade } from '../components/ArtworkUpgrade'
import { ServerRestart } from '../components/ServerRestart'
import { VpnControl } from '../components/VpnControl'
import { LibraryScan } from '../components/LibraryScan'
import { StreamingQuality } from '../components/StreamingQuality'
import { Normalisation } from '../components/Normalisation'
import { QualitySettings } from '../components/QualitySettings'

type VersionInfo = { version: string | null; contract: number | null }
type VersionState = { app: VersionInfo | null; agent: VersionInfo | null; error: string | null }

export function Settings() {
  const session = useAuth((s) => s.session)
  const logout = useAuth((s) => s.logout)
  const cloudStatus = useReleaseMetadata((s) => s.cloudStatus)
  const loadMetadata = useReleaseMetadata((s) => s.load)
  const isAdmin = useAuth((s) => s.isAdmin)
  const [versions, setVersions] = useState<VersionState>({ app: null, agent: null, error: null })

  useEffect(() => {
    if (isAdmin !== true || !session) return
    let active = true
    const load = async () => {
      try {
        const headers = { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
        const [appResponse, agentResponse] = await Promise.all([fetch('/api/version'), fetch('/api/recovery-agent/status', { headers })])
        if (!appResponse.ok || !agentResponse.ok) throw new Error('Version information is unavailable.')
        const [app, agent] = await Promise.all([appResponse.json(), agentResponse.json()]) as [VersionInfo, VersionInfo]
        if (active) setVersions({ app, agent, error: null })
      } catch (error) {
        if (active) setVersions((current) => ({ ...current, error: error instanceof Error ? error.message : 'Version information is unavailable.' }))
      }
    }
    void load()
    return () => { active = false }
  }, [isAdmin, session])

  // Everyone else gets only their per-device playback choice and sign out; server controls stay admin-only.
  if (isAdmin !== true) return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>{isAdmin === null ? 'Checking your account…' : 'Server settings are only available to Navidrome administrators.'}</p></header>{isAdmin === false && <><section className="settings-card"><h2>Playback</h2><StreamingQuality/><Normalisation/></section><section className="settings-card"><div className="setting-row"><LockKeyhole/><span><strong>Signed in as {session?.username}</strong><small>Ask an administrator if you need something changed.</small></span></div><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section></>}</div>

  // Site-only deploys change the app version without touching the agent, so only a contract difference needs a redeploy.
  const mismatch = Boolean(versions.app && versions.agent && versions.app.contract !== versions.agent.contract)
  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow">Tomify</span><h1>Settings</h1><p>Your account and playback setup.</p></header><section className="settings-card"><h2>Music server</h2><div className="setting-row"><Server/><span><strong>{session?.serverUrl}</strong><small>Signed in as {session?.username}</small></span><i className="connected">Connected</i></div><div className="setting-row"><ShieldCheck/><span><strong>Navidrome authentication</strong><small>Tomify stores a revocable token, never your password.</small></span></div><LibraryScan/><VpnControl/><ServerRestart/></section><section className="settings-card"><h2>Tomify metadata</h2><div className="setting-row"><Database/><span><strong>{cloudStatus === 'cloud' ? 'Cloud metadata connected' : cloudStatus === 'checking' ? 'Checking metadata store…' : 'Metadata store unavailable'}</strong><small>{cloudStatus === 'cloud' ? 'Release type and date overrides are stored centrally and shared across devices.' : 'Tomify is not saving release overrides locally.'}</small></span>{cloudStatus !== 'cloud' && <button className="button secondary" onClick={() => void loadMetadata()}>Retry</button>}</div><ArtworkUpgrade/></section><section className="settings-card"><h2>Playback</h2><StreamingQuality/><Normalisation/></section><QualitySettings/><section className="settings-card"><h2>Versions</h2><div className="setting-row"><GitCommitHorizontal/><span><strong>App {versions.app?.version ?? 'Checking…'}</strong><small>Contract {versions.app?.contract ?? '—'}</small></span></div><div className="setting-row"><Server/><span><strong>Recovery agent {versions.agent?.version ?? (versions.error ? 'Unavailable' : 'Checking…')}</strong><small>Contract {versions.agent?.contract ?? '—'}</small></span></div>{mismatch && <div className="login-error" role="alert"><AlertTriangle/>The recovery agent does not match this version of the site. Redeploy the recovery agent before using Recovery.</div>}{versions.error && <p className="login-error" role="alert">{versions.error}</p>}</section><section className="settings-card"><h2>Session</h2><button className="button danger" onClick={logout}><LogOut/>Sign out</button></section></div>
}
