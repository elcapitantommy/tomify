import { useState } from 'react'
import { LoaderCircle, Power } from 'lucide-react'
import { systemApi } from '../lib/recovery-api'

type RestartState = { phase: 'idle' | 'confirming' | 'restarting' | 'requested' } | { phase: 'failed'; message: string }

export function ServerRestart() {
  const [state, setState] = useState<RestartState>({ phase: 'idle' })

  async function restart() {
    setState({ phase: 'restarting' })
    try {
      await systemApi.restartServer()
      setState({ phase: 'requested' })
    } catch (error) {
      setState({ phase: 'failed', message: error instanceof Error ? error.message : 'The media server could not be restarted.' })
    }
  }

  const detail = state.phase === 'requested' ? 'Restart requested. Music and Recovery will be unavailable for a few minutes while the server comes back.'
    : state.phase === 'failed' ? state.message
      : state.phase === 'confirming' ? 'Playback, downloads and imports in progress will stop. Restart now?'
        : 'Reboots the home media server through its tunnel, for when SSH cannot reach it. Administrators only.'

  return <div className="setting-row"><Power/><span><strong>Restart media server</strong><small role={state.phase === 'failed' ? 'alert' : undefined}>{detail}</small></span>
    {state.phase === 'confirming' ? <><button className="button secondary" onClick={() => setState({ phase: 'idle' })}>Cancel</button><button className="button danger" onClick={() => void restart()}>Restart now</button></>
      : state.phase === 'restarting' ? <button className="button danger" disabled><LoaderCircle className="spin"/>Restarting…</button>
        : state.phase === 'requested' ? null
          : <button className="button danger" onClick={() => setState({ phase: 'confirming' })}>Restart</button>}
  </div>
}
