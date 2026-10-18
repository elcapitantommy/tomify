import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EQ_BANDS, EQ_PRESETS, clampGain, type EqPresetId } from '../lib/equaliser'

interface EqualiserState {
  enabled: boolean
  preset: EqPresetId
  gains: number[]
  setEnabled(enabled: boolean): void
  choosePreset(preset: Exclude<EqPresetId, 'custom'>): void
  setBand(index: number, gain: number): void
}

const flat = () => EQ_BANDS.map(() => 0)

// Per device, like streaming quality: speakers and headphones differ.
export const useEqualiser = create<EqualiserState>()(persist((set) => ({
  enabled: false,
  preset: 'flat',
  gains: flat(),
  setEnabled: (enabled) => set({ enabled }),
  choosePreset: (preset) => set({ preset, gains: [...(EQ_PRESETS.find((candidate) => candidate.id === preset)?.gains ?? flat())] }),
  setBand: (index, gain) => set((state) => {
    const gains = EQ_BANDS.map((_, band) => clampGain(band === index ? gain : state.gains[band] ?? 0))
    const match = EQ_PRESETS.find((candidate) => candidate.gains.every((value, band) => value === gains[band]))
    return { gains, preset: match?.id ?? 'custom' }
  }),
}), { name: 'tomify-equaliser', partialize: ({ enabled, preset, gains }) => ({ enabled, preset, gains }) }))
