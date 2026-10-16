import type { RouteHandler } from '../env.ts'
import { handleAlbumArtworkRequest } from '../features/album-artwork.ts'

export const albumArtworkRoute: RouteHandler = handleAlbumArtworkRequest
