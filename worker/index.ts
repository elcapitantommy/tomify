import type { RouteHandler } from './env.ts'
import { schemaOutOfDateResponse } from './lib/d1.ts'
import { json } from './lib/http.ts'
import { albumArtworkRoute } from './routes/album-artwork.ts'
import { catalogueRoute } from './routes/catalogue.ts'
import { inventoryRoute } from './routes/inventory.ts'
import { livePlaybackRoute } from './routes/live-playback.ts'
import { navidromeRoute } from './routes/navidrome.ts'
import { playlistsRoute } from './routes/playlists.ts'
import { releaseMetadataRoute } from './routes/release-metadata.ts'
import { handleRecoveryRequest } from './routes/recovery.ts'
import { systemSettingsRoute } from './routes/system-settings.ts'
import { versionRoute } from './routes/version.ts'

const routes: RouteHandler[] = [
  catalogueRoute,
  releaseMetadataRoute,
  albumArtworkRoute,
  playlistsRoute,
  livePlaybackRoute,
  systemSettingsRoute,
  inventoryRoute,
  versionRoute,
  handleRecoveryRequest,
  navidromeRoute,
]

const worker = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      for (const route of routes) {
        const response = await route(request, env, url)
        if (response) return response
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return json({ error: 'not-found' }, 404)
      if (env?.ASSETS) return env.ASSETS.fetch(request)
      return new Response(null, { status: 404 })
    } catch (error) {
      const schemaResponse = schemaOutOfDateResponse(error)
      if (schemaResponse) return schemaResponse
      throw error
    }
  },
}

export default worker
