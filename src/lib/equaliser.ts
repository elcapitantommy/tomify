// The equaliser: both player audio elements run through one Web Audio chain of ten peaking filters
// and a pre-amp. It is built the first time the equaliser is switched on, because routing an element
// through Web Audio can't be undone; switching it off afterwards just flattens the filters.
//
// Not on iPhone or iPad: WebKit suspends a page's AudioContext when the screen locks or the app goes
// to the background, which would silence lock-screen playback. There the setting is hidden.

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_MAX_DB = 12

export type EqPresetId = 'flat' | 'bass' | 'treble' | 'vocal' | 'loudness' | 'custom'
export const EQ_PRESETS: { id: Exclude<EqPresetId, 'custom'>; label: string; gains: number[] }[] = [
  { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: 'Bass boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', label: 'Treble boost', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  { id: 'vocal', label: 'Vocal', gains: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1] },
  { id: 'loudness', label: 'Loudness', gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
]

export function bandLabel(frequency: number) {
  return frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`
}

export function clampGain(value: number) {
  return Number.isFinite(value) ? Math.min(EQ_MAX_DB, Math.max(-EQ_MAX_DB, Math.round(value))) : 0
}

// Boosting a band would push loud passages past full scale, so the whole chain is turned down by the
// biggest boost first.
export function preampDb(gains: readonly number[]) {
  return -Math.max(0, ...gains)
}

type AudioContextClass = typeof AudioContext

function audioContextClass(): AudioContextClass | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext
}

export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined' ? undefined : navigator) {
  if (!nav) return false
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
}

export function equaliserSupported() {
  return Boolean(audioContextClass()) && !isAppleMobile()
}

export class EqualiserGraph {
  private context: AudioContext | null = null
  private filters: BiquadFilterNode[] = []
  private preamp: GainNode | null = null
  private readonly routed = new WeakSet<HTMLMediaElement>()

  get active() { return this.context !== null }

  // Routes the elements through the chain, building it on first use.
  attach(elements: HTMLMediaElement[]) {
    if (!this.context) {
      const Context = audioContextClass()
      if (!Context) return false
      const context = new Context()
      this.filters = EQ_BANDS.map((frequency, index) => {
        const filter = context.createBiquadFilter()
        filter.type = index === 0 ? 'lowshelf' : index === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
        filter.frequency.value = frequency
        filter.Q.value = 1.1
        filter.gain.value = 0
        return filter
      })
      this.preamp = context.createGain()
      this.filters.reduce<AudioNode>((previous, filter) => { previous.connect(filter); return filter }, this.preamp)
      this.filters[this.filters.length - 1].connect(context.destination)
      this.context = context
    }
    for (const element of elements) {
      if (this.routed.has(element)) continue
      this.context.createMediaElementSource(element).connect(this.preamp!)
      this.routed.add(element)
    }
    return true
  }

  // Flat gains when the equaliser is switched off.
  apply(gains: readonly number[], enabled: boolean) {
    if (!this.context || !this.preamp) return
    const values = EQ_BANDS.map((_, index) => enabled ? clampGain(gains[index] ?? 0) : 0)
    this.filters.forEach((filter, index) => { filter.gain.value = values[index] })
    this.preamp.gain.value = 10 ** (preampDb(values) / 20)
  }

  // A context made before the listener pressed anything starts suspended, and routed audio is silent until it runs.
  resume() {
    if (this.context && this.context.state !== 'running') void this.context.resume().catch(() => undefined)
  }
}
