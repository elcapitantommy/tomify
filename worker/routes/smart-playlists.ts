import type { RouteHandler } from '../env.ts'
import { handleSmartPlaylistRequest } from '../features/smart-playlists.ts'

export const smartPlaylistsRoute: RouteHandler = handleSmartPlaylistRequest
