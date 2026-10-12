import { ListPlus, MoreHorizontal, Play } from 'lucide-react'
import type { Track } from '../types'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../stores/player'
import { localPlaybackDeviceId, useLivePlayback } from '../stores/livePlayback'

export function TrackList({ tracks, discAware = false }: { tracks: Track[]; discAware?: boolean }) {
  const playTracks = usePlayer((s) => s.playTracks); const add = usePlayer((s) => s.addToQueue)
  const localQueue = usePlayer((s) => s.queue)
  const localCurrentIndex = usePlayer((s) => s.currentIndex)
  const live = useLivePlayback((s) => s.snapshot)
  const remoteTrack = live &&
    live.deviceId !== localPlaybackDeviceId &&
    Date.now() - live.updatedAt < 10_000
      ? live.queue[live.currentIndex]
      : undefined
  const currentTrackId = remoteTrack?.id ?? localQueue[localCurrentIndex]?.id
  const discs: Record<string, Track[]> = discAware ? tracks.reduce<Record<string, Track[]>>((groups, track) => { const key = String(track.discNumber ?? 1); (groups[key] ??= []).push(track); return groups }, {}) : { '': tracks }
  return <div className="track-groups">{Object.entries(discs).map(([disc, items]) => <section key={disc}>{disc && Object.keys(discs).length > 1 && <h3 className="disc-label">Disc {disc}</h3>}<ol className="track-list">{items?.map((track) => <li key={track.id} className={track.id === currentTrackId ? 'current-track' : undefined}><button className="track-main" onClick={() => playTracks(tracks, tracks.indexOf(track))}><span className="track-number"><span>{track.track ?? tracks.indexOf(track) + 1}</span><Play size={15} fill="currentColor"/></span><span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span></button><span className="track-album">{track.album}</span><span className="track-duration">{formatDuration(track.duration)}</span><button className="icon-button" onClick={() => add(track)} aria-label={`Add ${track.title} to queue`} title="Add to queue"><ListPlus/></button><button className="icon-button more" aria-label={`More options for ${track.title}`}><MoreHorizontal/></button></li>)}</ol></section>)}</div>
}
