import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// What new downloads are saved as on this device. Songs already downloaded keep the quality they were saved in.
// original: the untouched file (stream.view format=raw).
// high / small: an MP3 the music server makes on the fly (stream.view format=mp3 with maxBitRate).
export type DownloadQuality = 'original' | 'high' | 'small'

export const DOWNLOAD_QUALITY_OPTIONS: { value: DownloadQuality; label: string; detail: string; kbps?: number }[] = [
  { value: 'original', label: 'Original', detail: 'The untouched file. A FLAC song is often 25 to 40 MB.' },
  { value: 'high', label: 'High (MP3 320 kbps)', detail: 'About 2.4 MB a minute, a quarter of a FLAC file or less.', kbps: 320 },
  { value: 'small', label: 'Space saver (MP3 128 kbps)', detail: 'About 1 MB a minute. Fits the most music on the phone.', kbps: 128 },
]

export const downloadBitRate = (quality: DownloadQuality | undefined) => DOWNLOAD_QUALITY_OPTIONS.find((option) => option.value === quality)?.kbps
export const downloadQualityLabel = (quality: DownloadQuality | undefined) => quality === 'high' ? 'MP3 320' : quality === 'small' ? 'MP3 128' : 'Original'

interface DownloadQualityState { quality: DownloadQuality; setQuality(quality: DownloadQuality): void }

export const useDownloadQuality = create<DownloadQualityState>()(persist((set) => ({
  quality: 'original',
  setQuality: (quality) => set({ quality }),
}), { name: 'tomify-download-quality' }))
