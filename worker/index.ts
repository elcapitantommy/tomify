import type { ExportedHandler } from '@cloudflare/workers-types'
import type { RouteHandler } from './env.ts'
import type { Env } from './env.ts'
import { schemaOutOfDateResponse } from './lib/d1.ts'
import { json } from './lib/http.ts'
import { isNavidromeConfigurationError } from './lib/navidrome.ts'
import { albumArtworkRoute } from './routes/album-artwork.ts'
import { catalogueRoute } from './routes/catalogue.ts'
import { refreshCataloguePlaylists } from './features/catalogue.ts'
import { checkNewReleases } from './features/new-releases.ts'
import { newReleasesRoute } from './routes/new-releases.ts'
import { hlsRoute } from './routes/hls.ts'
import { djRoute } from './routes/dj.ts'
import { inventoryRoute } from './routes/inventory.ts'
import { libraryMovesRoute } from './routes/library-moves.ts'
import { lyricsRoute } from './routes/lyrics.ts'
import { listeningRoute } from './routes/listening.ts'
import { livePlaybackRoute } from './routes/live-playback.ts'
import { mediaSessionRoute } from './routes/media-session.ts'
import { mixesRoute } from './routes/mixes.ts'
import { navidromeRoute } from './routes/navidrome.ts'
import { partyRoute } from './routes/party.ts'
import { playlistsRoute } from './routes/playlists.ts'
import { releaseMetadataRoute } from './routes/release-metadata.ts'
import { handleRecoveryRequest } from './routes/recovery.ts'
import { smartPlaylistsRoute } from './routes/smart-playlists.ts'
import { systemSettingsRoute } from './routes/system-settings.ts'
import { versionRoute } from './routes/version.ts'

const routes: RouteHandler[] = [
  catalogueRoute,
  releaseMetadataRoute,
  albumArtworkRoute,
  playlistsRoute,
  livePlaybackRoute,
  listeningRoute,
  lyricsRoute,
  smartPlaylistsRoute,
  newReleasesRoute,
  partyRoute,
  mixesRoute,
  djRoute,
  systemSettingsRoute,
  inventoryRoute,
  libraryMovesRoute,
  versionRoute,
  hlsRoute,
  mediaSessionRoute,
  handleRecoveryRequest,
  navidromeRoute,
]

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url)
      for (const route of routes) {
        const response = await route(request, env, url, ctx)
        if (response) return response
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return json({ error: 'not-found' }, 404)
      if (env?.ASSETS) return env.ASSETS.fetch(request)
      return new Response(null, { status: 404 })
    } catch (error) {
      if (isNavidromeConfigurationError(error)) return json({ error: 'navidrome-unavailable', message: error.message }, 503)
      const schemaResponse = schemaOutOfDateResponse(error)
      if (schemaResponse) return schemaResponse
      throw error
    }
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshCataloguePlaylists(env))
    ctx.waitUntil(checkNewReleases(env))
  },
}

export default worker
