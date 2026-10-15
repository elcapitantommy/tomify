import { ListMusic, Play, Shuffle } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { SharePlaylist } from '../components/SharePlaylist'
import { ErrorState, SkeletonGrid } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { formatHours } from '../lib/format'
import { shareFromOwner, sharedWithFor } from '../lib/playlist-shares'
import { loadPlaylistShares, saveNavidromePlaylistShares } from '../lib/playlist-sharing'
import { usePlayer } from '../stores/player'

export function PlaylistDetail() {
  const api = useApi(); const { id = '' } = useParams()
  const { data, loading, error, retry } = useLoad(async (signal) => { const shares = await loadPlaylistShares(); const playlist = await api.playlist(id, signal, shareFromOwner(shares, 'navidrome', id)?.owner); return { playlist, shares } }, [api, id])
  if (loading) return <div className="page"><SkeletonGrid/></div>; if (error) return <div className="page"><ErrorState message={error} retry={retry}/></div>; if (!data) return null
  const { playlist, shares } = data; const tracks = playlist.entry ?? []; const owned = api.ownsPlaylist(playlist)
  return <div className="page detail-page"><header className="detail-hero playlist-hero"><div className="playlist-cover"><ListMusic/></div><div><span className="eyebrow">{owned ? 'Playlist' : `Shared by ${playlist.owner}`}</span><h1>{playlist.name}</h1><p>{tracks.length} songs · {formatHours(playlist.duration)}</p><div className="hero-actions"><button className="button primary" onClick={() => usePlayer.getState().playTracks(tracks)}><Play fill="currentColor"/>Play</button><button className="button secondary" onClick={() => usePlayer.getState().playTracks([...tracks].sort(() => Math.random() - .5))}><Shuffle/>Shuffle</button>{owned && shares && <SharePlaylist accounts={shares.accounts} sharedWith={sharedWithFor(shares, 'navidrome', playlist.id)} save={(users) => saveNavidromePlaylistShares(api, playlist.id, users)}/>}</div></div></header><TrackList tracks={tracks}/></div>
}
