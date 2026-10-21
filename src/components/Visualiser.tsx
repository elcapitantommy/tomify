import { useEffect, useRef } from 'react'
import { AudioLines } from 'lucide-react'
import { useOptionalApi } from '../lib/api-context'
import { activeAnalyser, equaliserSupported } from '../lib/equaliser'
import { barHeights, visualiserLabels, wavePoints } from '../lib/visualiser'
import { useVisualiser } from '../stores/visualiser'

const BAR_COUNT = 48

// Only where the player can route its audio through Web Audio: not on iPhone or iPad (see lib/equaliser.ts),
// and not when the music comes from another origin without CORS.
function useVisualiserAvailable() {
  const api = useOptionalApi()
  return Boolean(api && equaliserSupported() && api.streamsSameOrigin())
}

// Moving bars or a wave drawn behind the artwork, from the music this device is playing.
// It draws nothing while another device plays or nothing is coming through.
export function Visualiser({ className = '', active = true }: { className?: string; active?: boolean }) {
  const mode = useVisualiser((state) => state.mode)
  const available = useVisualiserAvailable()
  const canvas = useRef<HTMLCanvasElement>(null)
  const running = mode !== 'off' && available && active

  useEffect(() => {
    const element = canvas.current
    if (!running || !element) return
    const context = element.getContext('2d')
    if (!context) return
    let frame = 0
    let buffer = new Uint8Array(0)
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const ratio = window.devicePixelRatio || 1
      const width = Math.round(element.clientWidth * ratio)
      const height = Math.round(element.clientHeight * ratio)
      if (element.width !== width) element.width = width
      if (element.height !== height) element.height = height
      context.clearRect(0, 0, width, height)
      const analyser = activeAnalyser()
      if (!analyser || !width || !height) return
      const size = mode === 'bars' ? analyser.frequencyBinCount : analyser.fftSize
      if (buffer.length !== size) buffer = new Uint8Array(size)
      const style = getComputedStyle(element)
      const colour = style.color || '#d1fd61'
      const fromBottom = style.getPropertyValue('--visualiser-anchor').trim() === 'bottom'
      context.fillStyle = colour
      context.strokeStyle = colour
      if (mode === 'bars') {
        analyser.getByteFrequencyData(buffer)
        const heights = barHeights(buffer, BAR_COUNT)
        const slot = width / BAR_COUNT
        const bar = slot * 0.62
        heights.forEach((value, index) => {
          const h = Math.max(ratio * 2, value * value * height * 0.98)
          // Mirrored about the middle, so the bars reach out around the artwork; on phones the CSS
          // moves the canvas over the bottom of the artwork and the bars rise from the bottom.
          context.fillRect(index * slot + (slot - bar) / 2, fromBottom ? height - h : (height - h) / 2, bar, h)
        })
      } else {
        analyser.getByteTimeDomainData(buffer)
        const points = wavePoints(buffer, 160)
        context.lineWidth = 3 * ratio
        context.lineJoin = 'round'
        context.beginPath()
        points.forEach((value, index) => {
          const x = (index / (points.length - 1)) * width
          const y = height / 2 + value * height * 0.45
          if (index === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        })
        context.stroke()
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [running, mode])

  if (!running) return null
  return <canvas ref={canvas} className={`visualiser ${mode} ${className}`.trim()} aria-hidden="true"/>
}

// Cycles Off → Bars → Wave.
export function VisualiserButton() {
  const mode = useVisualiser((state) => state.mode)
  const cycle = useVisualiser((state) => state.cycle)
  if (!useVisualiserAvailable()) return null
  const label = `Visualiser: ${visualiserLabels[mode]}`
  return <button type="button" className={mode !== 'off' ? 'active' : ''} onClick={cycle} aria-label={label} title={label} aria-pressed={mode !== 'off'}><AudioLines/></button>
}
