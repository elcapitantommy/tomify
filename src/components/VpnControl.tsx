import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, ShieldCheck, ShieldOff } from 'lucide-react'
import { systemApi, type VpnStatus } from '../lib/recovery-api'

type Phase = 'loading' | 'ready' | 'connecting' | 'disconnecting' | 'confirming-disconnect'

function describe(status: VpnStatus | null) {
  if (!status) return ''
  if (status.control === 'disabled') return 'VPN control is turned off on the server. Set TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true in the agent settings to use it.'
  if (status.state === 'unavailable') return status.message || 'NordVPN did not answer.'
  if (status.state === 'connected') return [status.city, status.country].filter(Boolean).join(', ') + (status.server ? ` · ${status.server}` : '') + (status.ip ? ` · ${status.ip}` : '')
  if (status.state === 'disconnected') return 'Downloads use your home connection. Torrents pause until the VPN is back.'
  if (status.state === 'connecting') return 'Connecting…'
  return 'NordVPN reported an unexpected state.'
}

export function VpnControl() {
  const [status, setStatus] = useState<VpnStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setStatus(await systemApi.vpnStatus()); setError(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'VPN status is unavailable.') }
    finally { setPhase('ready') }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function change(action: 'connect' | 'disconnect') {
    setPhase(action === 'connect' ? 'connecting' : 'disconnecting')
    setError(null)
    try { setStatus(await systemApi.changeVpn(action)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The VPN could not be changed.') }
    finally { setPhase('ready') }
  }

  const usable = status?.control === 'enabled' && status.state !== 'unavailable'
  const connected = status?.state === 'connected'
  const title = phase === 'loading' ? 'Checking VPN…'
    : !status ? 'VPN status unavailable'
      : connected ? 'VPN connected' : status.state === 'disconnected' ? 'VPN disconnected' : 'VPN status unknown'
  const detail = error ?? (phase === 'confirming-disconnect' ? 'Torrents stop and downloads use your home IP until you reconnect. Tailscale and the site stay up. Disconnect now?' : describe(status))

  return <div className="setting-row">{connected ? <ShieldCheck/> : <ShieldOff/>}<span><strong>{title}</strong><small role={error ? 'alert' : undefined}>{detail}</small></span>
    {phase === 'loading' ? null
      : phase === 'connecting' ? <button className="button secondary" disabled><LoaderCircle className="spin"/>Connecting…</button>
        : phase === 'disconnecting' ? <button className="button secondary" disabled><LoaderCircle className="spin"/>Disconnecting…</button>
          : phase === 'confirming-disconnect' ? <><button className="button secondary" onClick={() => setPhase('ready')}>Cancel</button><button className="button danger" onClick={() => void change('disconnect')}>Disconnect now</button></>
            : !usable ? <button className="button secondary" onClick={() => { setPhase('loading'); void refresh() }}>Refresh</button>
              : connected ? <button className="button secondary" onClick={() => setPhase('confirming-disconnect')}>Disconnect</button>
                : <button className="button primary" onClick={() => void change('connect')}>Connect</button>}
  </div>
}
