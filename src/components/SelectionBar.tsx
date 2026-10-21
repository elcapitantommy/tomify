import { Download, ListEnd, ListStart, Play, X } from 'lucide-react'
import type { Track } from '../types'
import { usePlayer } from '../stores/player'
import { useDownloads } from '../stores/downloads'
import { addToQueueAnywhere, playNextAnywhere } from '../stores/playbackHandoff'
import { AddToPlaylist } from './AddToPlaylist'

// The bar shown while songs are ticked in a list: act on all of them at once.
export function SelectionBar({ tracks, total, onSelectAll, onClear, onDone }: { tracks: Track[]; total: number; onSelectAll: () => void; onClear: () => void; onDone: () => void }) {
  const downloadsReady = useDownloads((state) => state.ready)
  const count = tracks.length
  const label = count === 1 ? '1 song' : `${count} songs`
  const after = (run: () => void) => () => { run(); onDone() }
  return <div className="selection-bar" role="toolbar" aria-label="Selected songs">
    <div className="selection-count"><strong>{count ? `${label} selected` : 'Tick songs to select them'}</strong>
      {count < total ? <button type="button" className="link-button" onClick={onSelectAll}>Select all</button> : <button type="button" className="link-button" onClick={onClear}>Clear</button>}</div>
    <div className="selection-actions">
      <button type="button" className="button primary" disabled={!count} onClick={after(() => usePlayer.getState().playTracks(tracks, 0, { keepOrder: true }))}><Play fill="currentColor"/>Play</button>
      <button type="button" className="button secondary" disabled={!count} onClick={after(() => playNextAnywhere(tracks))}><ListStart/>Play next</button>
      <button type="button" className="button secondary" disabled={!count} onClick={after(() => tracks.forEach((track) => addToQueueAnywhere(track)))}><ListEnd/>Add to queue</button>
      {count > 0 && <AddToPlaylist songIds={tracks.map((track) => track.id)} label={label} variant="button"/>}
      {downloadsReady && <button type="button" className="button secondary" disabled={!count} onClick={after(() => void useDownloads.getState().downloadTracks(tracks))}><Download/>Download</button>}
      <button type="button" className="icon-button selection-close" onClick={onDone} aria-label="Stop selecting" title="Done"><X/></button>
    </div>
  </div>
}
