import { useEffect, useRef, useState } from 'react'
import { Check, Moon } from 'lucide-react'
import { SLEEP_TIMER_MINUTES, sleepTimerLabel, useSleepTimer } from '../stores/sleepTimer'

// Now Playing's sleep timer button: a menu of lengths, "End of this song" and Off.
export function SleepTimerButton() {
  const timer = useSleepTimer((state) => state.timer)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const container = useRef<HTMLDivElement>(null)

  // The minutes left refresh while the timer runs.
  useEffect(() => {
    if (timer?.kind !== 'minutes') return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(interval)
  }, [timer])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const label = sleepTimerLabel(timer, now)
  const { startMinutes, startEndOfTrack, cancel } = useSleepTimer.getState()
  const choose = (action: () => void) => { action(); setOpen(false) }

  return <div className="device-picker down sleep-timer" ref={container}>
    <button type="button" className={timer ? 'active' : ''} onClick={() => setOpen(!open)} aria-label={label ? `Sleep timer: ${label}` : 'Sleep timer'} aria-expanded={open} title={label ?? 'Sleep timer'}><Moon/></button>
    {open && <div className="device-menu" role="menu">
      <strong>Sleep timer</strong>
      {label && <p className="sleep-timer-status">{label}</p>}
      {SLEEP_TIMER_MINUTES.map((minutes) => {
        const active = timer?.kind === 'minutes' && timer.minutes === minutes
        return <button type="button" role="menuitem" key={minutes} className={active ? 'active' : ''} onClick={() => choose(() => startMinutes(minutes))}><span>{minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`}</span>{active && <Check/>}</button>
      })}
      <button type="button" role="menuitem" className={timer?.kind === 'end-of-track' ? 'active' : ''} onClick={() => choose(startEndOfTrack)}><span>End of this song</span>{timer?.kind === 'end-of-track' && <Check/>}</button>
      {timer && <button type="button" role="menuitem" onClick={() => choose(cancel)}><span>Turn off timer</span></button>}
    </div>}
  </div>
}
