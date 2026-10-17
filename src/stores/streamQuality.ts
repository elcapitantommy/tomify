import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// adaptive: chunked streaming that follows the signal (default).
// original-on-wifi: the untouched file on Wi-Fi, adaptive on mobile data.
// original: always the untouched file, as Tomify streamed before adaptive streaming.
export type StreamQuality = 'adaptive' | 'original-on-wifi' | 'original'

export const STREAM_QUALITY_OPTIONS: { value: StreamQuality; label: string; detail: string }[] = [
  { value: 'adaptive', label: 'Adaptive', detail: 'Drops to a smaller stream on a weak signal and climbs back up when it improves.' },
  { value: 'original-on-wifi', label: 'Original on Wi-Fi', detail: 'Lossless on Wi-Fi, adaptive on mobile data.' },
  { value: 'original', label: 'Always original', detail: 'Streams the original file. Uses the most data and stalls on a weak signal.' },
]

interface StreamQualityState { quality: StreamQuality; setQuality(quality: StreamQuality): void }

export const useStreamQuality = create<StreamQualityState>()(persist((set) => ({
  quality: 'adaptive',
  setQuality: (quality) => set({ quality }),
}), { name: 'tomify-stream-quality' }))
