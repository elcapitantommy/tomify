import { useState } from 'react'
import { CheckSquare, Play } from 'lucide-react'
import type { Track } from '../types'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../stores/player'
import { useRemoteSession } from '../stores/livePlayback'
import { TrackMenu } from './TrackMenu'
import { StartRadioButton } from './SongRadio'
import { StarButton } from './StarButton'
import { RatingStars } from './RatingStars'
import { AddToPlaylist } from './AddToPlaylist'
import { TrackDownloadButton } from './DownloadButton'
import { ItemArtists } from './ArtistLinks'
import { SelectionBar } from './SelectionBar'
import { selectedItems, toggleSelection } from '../lib/selection'

// `trackActions` adds extra buttons at the end of each row, such as the playlist editor's move and remove controls.
// `selectable` offers Select, which ticks several songs to play, queue, add to a playlist or download together.
export function TrackList({ tracks, discAware = false, addToPlaylist = true, trackActions, selectable = true }: { tracks: Track[]; discAware?: boolean; addToPlaylist?: boolean; trackActions?: (track: Track, index: number) => React.ReactNode; selectable?: boolean }) {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const playTracks = usePlayer((s) => s.playTracks)
  const localQueue = usePlayer((s) => s.queue)
  const localCurrentIndex = usePlayer((s) => s.currentIndex)
  const { remote } = useRemoteSession(5000)
  const remoteTrack = remote?.queue[remote.currentIndex]
  const currentTrackId = remoteTrack?.id ?? localQueue[localCurrentIndex]?.id
  const discs: Record<string, Track[]> = discAware ? tracks.reduce<Record<string, Track[]>>((groups, track) => { const key = String(track.discNumber ?? 1); (groups[key] ??= []).push(track); return groups }, {}) : { '': tracks }
  const canSelect = selectable && tracks.length > 1
  const active = canSelect && selecting
  const stop = () => { setSelecting(false); setSelected(new Set()); setAnchor(null) }
  const tick = (index: number, range: boolean) => { setSelected((value) => toggleSelection(value, index, anchor, range)); setAnchor(index) }
  return <div className={`track-groups${active ? ' selecting' : ''}`}>{canSelect && <div className="track-list-tools"><button type="button" className="link-button" aria-pressed={selecting} onClick={() => selecting ? stop() : setSelecting(true)}><CheckSquare/>{selecting ? 'Done' : 'Select'}</button></div>}{Object.entries(discs).map(([disc, items]) => <section key={disc}>{disc && Object.keys(discs).length > 1 && <h3 className="disc-label">Disc {disc}</h3>}<ol className="track-list">{items?.map((track) => <li key={`${track.id}-${tracks.indexOf(track)}`} className={[track.id === currentTrackId ? 'current-track' : '', active && selected.has(tracks.indexOf(track)) ? 'selected' : ''].filter(Boolean).join(' ') || undefined}><div className="track-main">{active ? <span className="track-number track-check"><input type="checkbox" checked={selected.has(tracks.indexOf(track))} onChange={() => undefined} onClick={(event) => tick(tracks.indexOf(track), event.shiftKey)} aria-label={`Select ${track.title}`}/></span> : <span className="track-number"><span>{track.track ?? tracks.indexOf(track) + 1}</span><Play size={15} fill="currentColor"/></span>}<span className="track-copy"><button type="button" className="track-play" onClick={(event) => active ? tick(tracks.indexOf(track), event.shiftKey) : playTracks(tracks, tracks.indexOf(track))}><strong>{track.title}</strong></button><small><ItemArtists item={track}/></small></span></div><span className="track-album">{track.album}</span><span className="track-duration">{formatDuration(track.duration)}</span><RatingStars item={track} name={track.title} className="track-rating"/><StarButton item={track} kind="song" name={track.title}/><TrackMenu track={track}/>{addToPlaylist && <AddToPlaylist songIds={[track.id]} label={track.title}/>}<TrackDownloadButton track={track}/><StartRadioButton track={track}/>{trackActions?.(track, tracks.indexOf(track))}</li>)}</ol></section>)}{active && <SelectionBar tracks={selectedItems(tracks, selected)} total={tracks.length} onSelectAll={() => setSelected(new Set(tracks.map((_, index) => index)))} onClear={() => setSelected(new Set())} onDone={stop}/>}</div>
}
