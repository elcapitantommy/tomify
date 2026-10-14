import type { Track, TrackSourceResolver } from '../types'
import type { NavidromeClient } from './navidrome'

/** This boundary will check IndexedDB for a valid local copy before streaming in Phase 2. */
export class StreamFirstSourceResolver implements TrackSourceResolver {
  constructor(private readonly api: NavidromeClient) {}
  async resolve(track: Track): Promise<import('../types').PlaybackSource> { return { url: this.api.streamUrl(track.id), kind: 'stream' } }
}
