// The visualiser's drawing maths, kept apart from the canvas so it can be tested.
// Bars: the spectrum folded into a few bands spaced like hearing (more detail in the bass and mids).
// Wave: the waveform thinned to a fixed number of points.

export type VisualiserMode = 'off' | 'bars' | 'wave'
export const VISUALISER_MODES: VisualiserMode[] = ['off', 'bars', 'wave']
export const visualiserLabels: Record<VisualiserMode, string> = { off: 'Off', bars: 'Bars', wave: 'Wave' }

export function nextVisualiserMode(mode: VisualiserMode): VisualiserMode {
  return VISUALISER_MODES[(VISUALISER_MODES.indexOf(mode) + 1) % VISUALISER_MODES.length]
}

// Heights from 0 to 1 for `count` bars. Bin edges grow geometrically, and the top fifth of the
// spectrum (mostly silence in most music) is left out.
export function barHeights(frequency: ArrayLike<number>, count: number): number[] {
  const usable = Math.max(1, Math.floor(frequency.length * 0.8))
  const heights: number[] = []
  let start = 0
  for (let bar = 0; bar < count; bar++) {
    const end = Math.max(start + 1, Math.min(usable, Math.round(usable ** ((bar + 1) / count))))
    let peak = 0
    for (let bin = start; bin < end && bin < frequency.length; bin++) peak = Math.max(peak, frequency[bin])
    heights.push(peak / 255)
    start = Math.min(end, usable - 1)
  }
  return heights
}

// Points from -1 to 1 (silence is 0) for `count` points across the wave.
export function wavePoints(timeDomain: ArrayLike<number>, count: number): number[] {
  if (!timeDomain.length || count < 2) return []
  const points: number[] = []
  for (let point = 0; point < count; point++) {
    const index = Math.min(timeDomain.length - 1, Math.round((point / (count - 1)) * (timeDomain.length - 1)))
    points.push((timeDomain[index] - 128) / 128)
  }
  return points
}
