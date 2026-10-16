import type { RouteHandler } from '../env.ts'
import { handlePlaylistShareRequest } from '../features/playlist-share.ts'

export const playlistsRoute: RouteHandler = handlePlaylistShareRequest
