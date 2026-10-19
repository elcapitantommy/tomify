import type { Track, TrackSourceResolver } from '../types'
import type { NavidromeClient } from './navidrome'
import { localAudioUrl } from './offline-db'

export class StreamFirstSourceResolver implements TrackSourceResolver {
  constructor(private readonly api: NavidromeClient) {}
  async resolve(track: Track): Promise<import('../types').PlaybackSource> { return { url: this.api.streamUrl(track.id), kind: 'stream' } }
}

// A valid downloaded copy (see lib/offline-db.ts) plays from the device; anything else goes to the wrapped resolver.
// The object URL belongs to the download cache, which revokes it when the download is removed.
export class LocalFirstSourceResolver implements TrackSourceResolver {
  constructor(private readonly api: NavidromeClient, private readonly fallback: TrackSourceResolver = new StreamFirstSourceResolver(api)) {}
  async resolve(track: Track): Promise<import('../types').PlaybackSource> {
    const url = await localAudioUrl(this.api.session, track.id)
    return url ? { url, kind: 'local' } : this.fallback.resolve(track)
  }
}
