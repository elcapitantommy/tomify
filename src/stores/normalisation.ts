import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// auto: album gain while an album plays in order, track gain otherwise (default).
// album / track: always that gain. off: every track at its own loudness.
export type NormalisationSetting = 'auto' | 'album' | 'track' | 'off'

export const NORMALISATION_OPTIONS: { value: NormalisationSetting; label: string; detail: string }[] = [
  { value: 'auto', label: 'Automatic', detail: 'Keeps an album’s quiet and loud songs as the artist intended, and evens out everything else.' },
  { value: 'album', label: 'Album', detail: 'Every album plays at the same loudness, with its own dynamics kept.' },
  { value: 'track', label: 'Track', detail: 'Every song plays at the same loudness.' },
  { value: 'off', label: 'Off', detail: 'Each song plays as loud as it was mastered.' },
]

interface NormalisationState { setting: NormalisationSetting; setSetting(setting: NormalisationSetting): void }

export const useNormalisation = create<NormalisationState>()(persist((set) => ({
  setting: 'auto',
  setSetting: (setting) => set({ setting }),
}), { name: 'tomify-normalisation' }))
