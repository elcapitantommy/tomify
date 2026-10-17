import { ListPlus, Play } from 'lucide-react'
import type { Track } from '../types'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../stores/player'
import { useRemoteSession } from '../stores/livePlayback'
import { addToQueueAnywhere } from '../stores/playbackHandoff'
import { StarButton } from './StarButton'
import { AddToPlaylist } from './AddToPlaylist'

// `trackActions` adds extra buttons at the end of each row, such as the playlist editor's move and remove controls.
export function TrackList({ tracks, discAware = false, addToPlaylist = true, trackActions }: { tracks: Track[]; discAware?: boolean; addToPlaylist?: boolean; trackActions?: (track: Track, index: number) => React.ReactNode }) {
  const playTracks = usePlayer((s) => s.playTracks)
  const localQueue = usePlayer((s) => s.queue)
  const localCurrentIndex = usePlayer((s) => s.currentIndex)
  const { remote } = useRemoteSession(5000)
  const remoteTrack = remote?.queue[remote.currentIndex]
  const currentTrackId = remoteTrack?.id ?? localQueue[localCurrentIndex]?.id
  const discs: Record<string, Track[]> = discAware ? tracks.reduce<Record<string, Track[]>>((groups, track) => { const key = String(track.discNumber ?? 1); (groups[key] ??= []).push(track); return groups }, {}) : { '': tracks }
  return <div className="track-groups">{Object.entries(discs).map(([disc, items]) => <section key={disc}>{disc && Object.keys(discs).length > 1 && <h3 className="disc-label">Disc {disc}</h3>}<ol className="track-list">{items?.map((track) => <li key={`${track.id}-${tracks.indexOf(track)}`} className={track.id === currentTrackId ? 'current-track' : undefined}><button className="track-main" onClick={() => playTracks(tracks, tracks.indexOf(track))}><span className="track-number"><span>{track.track ?? tracks.indexOf(track) + 1}</span><Play size={15} fill="currentColor"/></span><span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span></button><span className="track-album">{track.album}</span><span className="track-duration">{formatDuration(track.duration)}</span><StarButton item={track} kind="song" name={track.title}/><button className="icon-button" onClick={() => addToQueueAnywhere(track)} aria-label={`Add ${track.title} to queue`} title="Add to queue"><ListPlus/></button>{addToPlaylist && <AddToPlaylist songIds={[track.id]} label={track.title}/>}{trackActions?.(track, tracks.indexOf(track))}</li>)}</ol></section>)}</div>
}
