import { useEffect } from 'react'
import { RadioTower } from 'lucide-react'
import type { Track } from '../types'
import { useOptionalApi } from '../lib/api-context'
import { bindRadio, useRadio } from '../stores/radio'

export function RadioRuntime() {
  const api = useOptionalApi()
  useEffect(() => api ? bindRadio(api) : undefined, [api])
  return null
}

export function StartRadioButton({ track, className = 'icon-button' }: { track: Track; className?: string }) {
  const active = useRadio((state) => state.seed?.id === track.id)
  return <button type="button" className={`${className} radio-start${active ? ' active' : ''}`} onClick={() => void useRadio.getState().start(track)} aria-label={`Start radio from ${track.title}`} title="Start radio"><RadioTower/></button>
}
