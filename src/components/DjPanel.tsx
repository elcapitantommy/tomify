import { useEffect, useState } from 'react'
import { Loader2, Radio, Send, Square } from 'lucide-react'
import { bindDj, useDj } from '../stores/dj'

// Keeps the DJ going while the app is open, whatever page is showing.
export function DjRuntime() {
  useEffect(() => bindDj(), [])
  return null
}

// Shows at once that a tap did something: "Starting DJ" while the first set is picked, then "Stop DJ".
export function DjButton() {
  const active = useDj((state) => state.active)
  const starting = useDj((state) => state.active && state.loading && !state.trackIds.length)
  if (starting) return <button className="button primary" disabled aria-busy="true"><Loader2 className="spin"/>Starting DJ…</button>
  if (active) return <button className="button primary" onClick={() => useDj.getState().stop()}><Square/>Stop DJ</button>
  return <button className="button secondary" onClick={() => void useDj.getState().start()}><Radio/>DJ</button>
}

export function DjPanel() {
  const { active, loading, speaking, script, voiceNote, error } = useDj()
  const [request, setRequest] = useState('')
  if (!active && !error) return null
  const send = (event: React.FormEvent) => {
    event.preventDefault()
    if (!request.trim()) return
    void useDj.getState().steer(request.trim())
    setRequest('')
  }
  return <section className="dj-panel" aria-label="Tomify DJ">
    <div className="dj-panel-head"><span className="eyebrow"><Radio size={14}/>{active ? (speaking ? 'DJ is talking' : 'DJ is on') : 'DJ'}</span></div>
    {active && <p className="dj-script">{script ?? (loading ? 'Picking your first songs…' : '')}</p>}
    {active && voiceNote && <p className="dj-voice-note">{voiceNote}</p>}
    {error && <p className="dj-error" role="alert">{error}</p>}
    {active && <form onSubmit={send} className="dj-request"><input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Tell the DJ: something calmer, 124 bpm house…" aria-label="Tell the DJ what you want" maxLength={200}/><button className="button secondary" type="submit" disabled={loading || !request.trim()}>{loading ? <Loader2 className="spin"/> : <Send/>}Send</button></form>}
  </section>
}
