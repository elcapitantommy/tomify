import { create } from 'zustand'
import { usePlayer } from './player'

// Sleep timer: pauses this device's playback after a number of minutes, or when the song playing now ends.
// It lives only in memory, so closing the app ends it, the same as the music.

export type SleepTimer = { kind: 'minutes'; minutes: number; endsAt: number } | { kind: 'end-of-track' }

export const SLEEP_TIMER_MINUTES = [15, 30, 45, 60, 90]

interface SleepTimerState {
  timer: SleepTimer | null
  startMinutes(minutes: number): void
  startEndOfTrack(): void
  cancel(): void
}

let timeout: ReturnType<typeof setTimeout> | undefined
const clear = () => { if (timeout !== undefined) clearTimeout(timeout); timeout = undefined }

function fire() {
  clear()
  useSleepTimer.setState({ timer: null })
  if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false)
}

export const useSleepTimer = create<SleepTimerState>()((set) => ({
  timer: null,
  startMinutes: (minutes) => {
    clear()
    const endsAt = Date.now() + minutes * 60_000
    set({ timer: { kind: 'minutes', minutes, endsAt } })
    timeout = setTimeout(fire, minutes * 60_000)
  },
  startEndOfTrack: () => { clear(); set({ timer: { kind: 'end-of-track' } }) },
  cancel: () => { clear(); set({ timer: null }) },
}))

// Phones hold back timers in a hidden page, so each progress update also checks the clock.
usePlayer.subscribe((state, previous) => {
  const timer = useSleepTimer.getState().timer
  if (timer?.kind === 'minutes' && state.currentTime !== previous.currentTime && Date.now() >= timer.endsAt) fire()
})

// Asked by the player while a song plays out: true means let it finish rather than start the next one early.
export const sleepsAtTrackEnd = () => useSleepTimer.getState().timer?.kind === 'end-of-track'

// Called by the player when a song ends on its own. True means the timer took it: stop instead of playing on.
export function takeTrackEnd() {
  if (!sleepsAtTrackEnd()) return false
  clear()
  useSleepTimer.setState({ timer: null })
  return true
}

export function sleepTimerLabel(timer: SleepTimer | null, now = Date.now()) {
  if (!timer) return null
  if (timer.kind === 'end-of-track') return 'Stops after this song'
  const left = Math.max(0, Math.ceil((timer.endsAt - now) / 60_000))
  return left <= 1 ? 'Stops in under a minute' : `Stops in ${left} min`
}
