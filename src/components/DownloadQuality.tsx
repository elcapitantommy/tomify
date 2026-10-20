import { HardDriveDownload } from 'lucide-react'
import { DOWNLOAD_QUALITY_OPTIONS, useDownloadQuality } from '../stores/downloadQuality'

/** Per-device choice of what new downloads are saved as. Songs already downloaded keep their quality. */
export function DownloadQuality() {
  const quality = useDownloadQuality((state) => state.quality)
  const setQuality = useDownloadQuality((state) => state.setQuality)
  return <fieldset className="streaming-quality download-quality">
    <legend><HardDriveDownload/>Download quality</legend>
    {DOWNLOAD_QUALITY_OPTIONS.map((option) => <label key={option.value}>
      <input type="radio" name="download-quality" value={option.value} checked={quality === option.value} onChange={() => setQuality(option.value)}/>
      <span><strong>{option.label}</strong><small>{option.detail}</small></span>
    </label>)}
    <p>Applies to new downloads on this device. To shrink a song already saved, remove it and download it again.</p>
  </fieldset>
}
