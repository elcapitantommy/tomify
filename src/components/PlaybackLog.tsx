import { useState } from 'react'
import { ScrollText } from 'lucide-react'
import { clearPlaybackLog, formatPlaybackLog, playbackLog } from '../lib/playbackLog'

function reportsDevices() {
  const devices = typeof navigator === 'undefined' ? undefined : (navigator as { mediaDevices?: MediaDevices }).mediaDevices
  return Boolean(devices && 'ondevicechange' in devices)
}

/** What started and stopped the music on this device lately, to copy into a bug report. */
export function PlaybackLog() {
  const [text, setText] = useState(() => formatPlaybackLog(playbackLog()))
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = () => setText(formatPlaybackLog(playbackLog()))
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNotice('Copied.') } catch { setNotice('Copy failed. Select the text and copy it yourself.') }
  }
  return <details className="playback-log" onToggle={(event) => { if (event.currentTarget.open) refresh() }}>
    <summary><ScrollText/>Playback log</summary>
    <p>What started or stopped the music on this device lately, such as headphone buttons and headphones disconnecting. Copy it when reporting a playback problem.</p>
    <p>{reportsDevices() ? 'This browser reports headphones connecting and disconnecting.' : 'This browser doesn’t report headphones connecting and disconnecting, so Tomify can’t tell a play they send as they drop out from a real one.'}</p>
    <pre aria-label="Playback log">{text || 'Nothing yet.'}</pre>
    <div className="playback-log-actions">
      <button type="button" className="button secondary" onClick={() => void copy()} disabled={!text}>Copy</button>
      <button type="button" className="button secondary" onClick={() => { clearPlaybackLog(); refresh(); setNotice(null) }} disabled={!text}>Clear</button>
      {notice && <small role="status">{notice}</small>}
    </div>
  </details>
}
