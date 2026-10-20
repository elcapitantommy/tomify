import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Radio, Send, Sparkles, Square, X } from 'lucide-react'
import { bindDj, fetchHeard, useDj } from '../stores/dj'
import { usePlayer } from '../stores/player'
import { canListen, listen, type Listening } from '../lib/dj-listen'

// Keeps the DJ going while the app is open, whatever page is showing.
export function DjRuntime() {
  useEffect(() => bindDj(), [])
  return null
}

// Opens the DJ panel (it doesn't start playing until asked), shows "Starting DJ" while the first set
// is picked, then "Stop DJ".
export function DjButton() {
  const active = useDj((state) => state.active)
  const open = useDj((state) => state.open)
  const starting = useDj((state) => state.active && state.loading && !state.trackIds.length)
  if (starting) return <button className="button primary" disabled aria-busy="true"><Loader2 className="spin"/>Starting DJ…</button>
  if (active) return <button className="button primary" onClick={() => useDj.getState().stop()}><Square fill="currentColor"/>Stop DJ</button>
  return <button className="button secondary" aria-expanded={open} onClick={() => open ? useDj.getState().closePanel() : useDj.getState().openPanel()}><Radio/>DJ</button>
}

// Shorter presses than this are taken as a tap, which gets a hint to hold the button instead.
export const DJ_TALK_MIN_MS = 350

// Hold to talk: the music pauses so the mic can hear you, and on letting go the DJ answers and the new
// songs start. Nothing heard, or a failed request, puts the music back on.
function DjTalk({ disabled, ask }: { disabled: boolean; ask?: (text: string) => Promise<boolean> }) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'hearing'>('idle')
  const [heard, setHeard] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const loading = useDj((state) => state.loading)
  const held = useRef<{ listening: Listening; resume: boolean; since: number } | null>(null)
  useEffect(() => () => held.current?.listening.cancel(), [])

  const begin = () => {
    if (held.current || disabled) return
    const player = usePlayer.getState()
    const resume = player.playing
    if (resume) player.setPlaying(false)
    setProblem(null)
    setHeard('')
    setPhase('listening')
    held.current = { listening: listen({ onHeard: setHeard, transcribe: (audio) => fetchHeard(audio) }), resume, since: Date.now() }
  }
  const end = async () => {
    const current = held.current
    if (!current) return
    held.current = null
    let text = ''
    let trouble: string | null = null
    if (Date.now() - current.since < DJ_TALK_MIN_MS) {
      current.listening.cancel()
      trouble = 'Hold the button down while you talk, then let go.'
    } else {
      setPhase('hearing')
      try {
        text = await current.listening.finish()
      } catch (reason) {
        trouble = reason instanceof Error ? reason.message : 'The DJ didn\'t catch that.'
      }
      if (!text && !trouble) trouble = 'The DJ didn\'t catch that. Hold the button while you talk.'
    }
    setPhase('idle')
    setHeard(text)
    setProblem(trouble)
    const steered = text ? await (ask ? ask(text) : useDj.getState().steer(text, { now: true })) : false
    if (!steered && current.resume && (ask || useDj.getState().active)) usePlayer.getState().setPlaying(true)
  }
  const key = (event: React.KeyboardEvent, down: boolean) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (down && !event.repeat) begin()
    else if (!down) void end()
  }

  const line = phase === 'listening' ? (heard || 'Listening…') : phase === 'hearing' ? (heard || 'Working out what you said…') : heard && loading ? `“${heard}”` : null
  return <>
    <button type="button" className={`button secondary dj-talk${phase === 'listening' ? ' listening' : ''}`} aria-label="Hold to talk to the DJ" aria-pressed={phase === 'listening'} disabled={disabled && phase === 'idle'}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); begin() }}
      onPointerUp={() => void end()} onPointerCancel={() => void end()} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => key(event, true)} onKeyUp={(event) => key(event, false)}>
      {phase === 'hearing' ? <Loader2 className="spin"/> : <Mic/>}
    </button>
    {(line || problem) && <p className="dj-heard" role="status">{line ?? problem}</p>}
  </>
}

export function DjPanel() {
  const { open, active, loading, speaking, script, voiceNote, error, pool } = useDj()
  const [request, setRequest] = useState('')
  const [talkable] = useState(canListen)
  if (!open && !active && !error) return null
  const send = (event: React.FormEvent) => {
    event.preventDefault()
    if (!request.trim()) return
    if (active) void useDj.getState().steer(request.trim())
    else void useDj.getState().start(request.trim())
    setRequest('')
  }
  // Before it starts: ask for something, or let the DJ choose.
  const ready = !active
  const startWith = async (text: string) => { await useDj.getState().start(text); return useDj.getState().active }
  return <section className="dj-panel" aria-label="Tomify DJ">
    <div className="dj-panel-head"><span className="eyebrow"><Radio size={14}/>{active ? (speaking ? 'DJ is talking' : 'DJ is on') : 'DJ'}{active && pool ? ` · ${pool.name}` : ''}</span>{ready && <button type="button" className="icon-button dj-close" aria-label="Close the DJ" onClick={() => useDj.getState().closePanel()}><X size={18}/></button>}</div>
    {ready && <p className="dj-script">What do you fancy? Tell the DJ, or let it pick.</p>}
    {active && <p className="dj-script">{script ?? (loading ? 'Picking your first songs…' : '')}</p>}
    {active && voiceNote && <p className="dj-voice-note">{voiceNote}</p>}
    {error && <p className="dj-error" role="alert">{error}</p>}
    <form onSubmit={send} className="dj-request">{talkable && <DjTalk disabled={ready ? loading : speaking} ask={ready ? startWith : undefined}/>}<input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Tell the DJ: something calmer, 124 bpm house…" aria-label="Tell the DJ what you want" maxLength={200}/><button className="button secondary" type="submit" disabled={loading || !request.trim()}>{loading ? <Loader2 className="spin"/> : <Send/>}Send</button></form>
    {ready && <button type="button" className="button primary dj-pick" disabled={loading} onClick={() => void useDj.getState().start()}><Sparkles/>Pick some songs for me</button>}
  </section>
}
